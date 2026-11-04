use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const TREASURY_WASM: &[u8] =
    include_bytes!("../../../target/wasm32-unknown-unknown/release/veltron_treasury.wasm");
const TOKEN_WASM: &[u8] =
    include_bytes!("../../../target/wasm32-unknown-unknown/release/veltron_test_token.wasm");

async fn view_json(contract: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(contract.call(method).args_json(args).view().await?.json()?)
}

async fn register_token_account(
    owner: &Account,
    token: &Contract,
    account_id: &str,
) -> anyhow::Result<()> {
    owner
        .call(token.id(), "storage_deposit")
        .args_json(json!({
            "account_id": account_id,
            "registration_only": true
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn sandbox_deposit_and_agent_payment_use_real_nep141_calls() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let vendor = worker.dev_create_account().await?;

    let token = worker.dev_deploy(TOKEN_WASM).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "10000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    register_token_account(&owner, &token, treasury.id().as_str()).await?;
    register_token_account(&owner, &token, vendor.id().as_str()).await?;

    let deposit_result = owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "1000",
            "memo": "Initial treasury funding",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    println!("Deposit transaction outcome: {:#?}", deposit_result);
    deposit_result.into_result()?;

    let token_balance_at_treasury =
        view_json(&token, "ft_balance_of", json!({ "account_id": treasury.id() })).await?;
    println!("Actual NEP-141 balance at treasury: {token_balance_at_treasury}");

    let funded_position = view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(funded_position["treasury_balance"], "1000");
    assert_eq!(funded_position["spendable_balance"], "900");

    // Give the complete cross-contract payment flow the maximum transaction gas
    // while diagnosing the prepaid-gas failure in Sandbox.
    let payment_result = agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": vendor.id(),
            "amount": "200",
            "memo": "Sandbox vendor payment"
        }))
        .max_gas()
        .transact()
        .await?;
    println!("Agent payment transaction outcome: {:#?}", payment_result);
    payment_result.clone().into_result()?;
    let callback_receipt = payment_result.receipt_outcomes().iter()
        .find(|receipt| receipt.logs.iter().any(|log| log == "VELTRON_TRANSFER_SUCCESS:0"))
        .expect("successful discretionary callback receipt must be present");
    let callback_gas = callback_receipt.gas_burnt.as_gas();
    println!("Discretionary success callback gas: {} Tgas", callback_gas as f64 / 1_000_000_000_000.0);
    assert!(callback_gas < 5_000_000_000_000, "callback consumed more than 5 Tgas: {}", callback_gas);

    let final_position = view_json(&treasury, "get_financial_position", json!({})).await?;
    let vendor_balance = view_json(
        &token,
        "ft_balance_of",
        json!({ "account_id": vendor.id() }),
    )
    .await?;

    assert_eq!(final_position["treasury_balance"], "800");
    assert_eq!(final_position["spendable_balance"], "700");
    assert_eq!(vendor_balance, "200");

    Ok(())
}





#[tokio::test]
async fn sandbox_commitment_settlement_success_failure_and_retry() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let paid_vendor = worker.dev_create_account().await?;
    let initially_unregistered_vendor = worker.dev_create_account().await?;

    let token = worker.dev_deploy(TOKEN_WASM).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "10000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    register_token_account(&owner, &token, treasury.id().as_str()).await?;
    register_token_account(&owner, &token, paid_vendor.id().as_str()).await?;

    owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "1000",
            "memo": "Fund commitment settlement test",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "create_commitment")
        .args_json(json!({
            "id": "paid-invoice",
            "recipient_id": paid_vendor.id(),
            "amount": "200",
            "description": "Registered vendor invoice"
        }))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "create_commitment")
        .args_json(json!({
            "id": "retry-invoice",
            "recipient_id": initially_unregistered_vendor.id(),
            "amount": "150",
            "description": "Vendor to register after failed settlement"
        }))
        .transact()
        .await?
        .into_result()?;

    // Fill the commitment collection to its configured maximum before settlement.
    // This stresses callback storage updates while the largest supported commitment set exists.
    for index in 0..254 {
        owner
            .call(treasury.id(), "create_commitment")
            .args_json(json!({
                "id": format!("filler-{index:03}"),
                "recipient_id": paid_vendor.id(),
                "amount": "1",
                "description": "Gas stress fixture"
            }))
            .transact()
            .await?
            .into_result()?;
    }

    // Registered recipient: the real NEP-141 transfer and callback should settle.
    let successful_settlement = owner
        .call(treasury.id(), "settle_commitment")
        .args_json(json!({ "id": "paid-invoice" }))
        .max_gas()
        .transact()
        .await?;
    successful_settlement.clone().into_result()?;
    let success_callback_receipt = successful_settlement.receipt_outcomes().iter()
        .find(|receipt| receipt.logs.iter().any(|log| log == "VELTRON_TRANSFER_SUCCESS:0"))
        .expect("successful commitment callback receipt must be present");
    let success_callback_gas = success_callback_receipt.gas_burnt.as_gas();
    println!("Commitment success callback gas at 256 commitments: {} Tgas",
        success_callback_gas as f64 / 1_000_000_000_000.0);
    println!("Commitment success callback phase logs: {:#?}", success_callback_receipt.logs);
    assert!(success_callback_gas < 5_000_000_000_000,
        "commitment success callback consumed more than 5 Tgas: {}", success_callback_gas);

    let after_success = view_json(&treasury, "get_financial_position", json!({})).await?;
    let paid_vendor_balance =
        view_json(&token, "ft_balance_of", json!({ "account_id": paid_vendor.id() })).await?;
    let commitments_after_success =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 50 })).await?;

    assert_eq!(after_success["treasury_balance"], "800");
    assert_eq!(paid_vendor_balance, "200");
    assert_eq!(after_success["active_commitments"], "404");
    assert_eq!(commitments_after_success["commitments"].as_array().unwrap().len(), 50);

    // Unregistered recipient: NEP-141 transfer fails, callback must preserve
    // the commitment and clear its settlement-pending lock.
    let failed_settlement = owner
        .call(treasury.id(), "settle_commitment")
        .args_json(json!({ "id": "retry-invoice" }))
        .max_gas()
        .transact()
        .await?;
    failed_settlement.clone().into_result()?;
    let failure_callback_receipt = failed_settlement.receipt_outcomes().iter()
        .find(|receipt| receipt.logs.iter().any(|log| log == "VELTRON_TRANSFER_FAILED:1"))
        .expect("failed commitment callback receipt must be present");
    let failure_callback_gas = failure_callback_receipt.gas_burnt.as_gas();
    println!("Commitment failure callback gas at 255 commitments: {} Tgas",
        failure_callback_gas as f64 / 1_000_000_000_000.0);
    assert!(failure_callback_gas < 5_000_000_000_000,
        "commitment failure callback consumed more than 5 Tgas: {}", failure_callback_gas);

    let after_failure = view_json(&treasury, "get_financial_position", json!({})).await?;
    let commitments_after_failure =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 50 })).await?;
    assert_eq!(after_failure["treasury_balance"], "800");
    assert_eq!(after_failure["active_commitments"], "404");
    assert_eq!(commitments_after_failure["commitments"].as_array().unwrap().len(), 50);

    // Register the recipient and retry: a failed settlement must be recoverable.
    register_token_account(&owner, &token, initially_unregistered_vendor.id().as_str()).await?;
    let retried_settlement = owner
        .call(treasury.id(), "settle_commitment")
        .args_json(json!({ "id": "retry-invoice" }))
        .max_gas()
        .transact()
        .await?;
    retried_settlement.clone().into_result()?;
    let retry_callback_receipt = retried_settlement.receipt_outcomes().iter()
        .find(|receipt| receipt.logs.iter().any(|log| log == "VELTRON_TRANSFER_SUCCESS:2"))
        .expect("retried commitment callback receipt must be present");
    let retry_callback_gas = retry_callback_receipt.gas_burnt.as_gas();
    println!("Commitment retry callback gas at 255 commitments: {} Tgas",
        retry_callback_gas as f64 / 1_000_000_000_000.0);
    assert!(retry_callback_gas < 5_000_000_000_000,
        "commitment retry callback consumed more than 5 Tgas: {}", retry_callback_gas);

    let after_retry = view_json(&treasury, "get_financial_position", json!({})).await?;
    let retry_vendor_balance = view_json(
        &token,
        "ft_balance_of",
        json!({ "account_id": initially_unregistered_vendor.id() }),
    )
    .await?;
    let final_commitments =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 50 })).await?;

    assert_eq!(after_retry["treasury_balance"], "650");
    assert_eq!(retry_vendor_balance, "150");
    assert_eq!(after_retry["active_commitments"], "254");
    assert_eq!(final_commitments["commitments"].as_array().unwrap().len(), 50);
    assert_eq!(after_retry["pending_discretionary"], "0");

    Ok(())
}




#[tokio::test]
async fn sandbox_direct_token_transfer_is_not_credited_to_internal_ledger() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;

    let token = worker.dev_deploy(TOKEN_WASM).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "10000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    register_token_account(&owner, &token, treasury.id().as_str()).await?;

    // Plain ft_transfer moves tokens but does not invoke ft_on_transfer.
    owner
        .call(token.id(), "ft_transfer")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "250",
            "memo": "Direct transfer without receiver hook"
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let position = view_json(&treasury, "get_financial_position", json!({})).await?;
    let actual_balance =
        view_json(&token, "ft_balance_of", json!({ "account_id": treasury.id() })).await?;

    // The token balance increased, but the internal ledger remains uncredited.
    assert_eq!(actual_balance, "250");
    assert_eq!(position["treasury_balance"], "0");
    assert_eq!(position["spendable_balance"], "0");

    Ok(())
}


#[tokio::test]
async fn sandbox_rejects_forged_and_unsupported_deposits() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;

    let token = worker.dev_deploy(TOKEN_WASM).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "10000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": attacker.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    register_token_account(&owner, &token, treasury.id().as_str()).await?;

    // A random account cannot impersonate the configured token contract.
    let forged = attacker
        .call(treasury.id(), "ft_on_transfer")
        .args_json(json!({
            "sender_id": owner.id(),
            "amount": "500",
            "msg": ""
        }))
        .transact()
        .await?;
    assert!(forged.into_result().is_err());

    let after_forgery =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(after_forgery["treasury_balance"], "0");

    let owner_balance_before =
        view_json(&token, "ft_balance_of", json!({ "account_id": owner.id() })).await?;

    // The configured token may call the receiver, but unsupported deposit
    // messages are rejected and NEP-141 must refund the unaccepted amount.
    let unsupported = owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "500",
            "memo": "Unsupported deposit test",
            "msg": "not-an-empty-message"
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    // Receiver failure is handled by the NEP-141 resolver; inspect final balances.
    let _ = unsupported;

    let after_unsupported =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    let owner_balance_after =
        view_json(&token, "ft_balance_of", json!({ "account_id": owner.id() })).await?;
    let treasury_token_balance =
        view_json(&token, "ft_balance_of", json!({ "account_id": treasury.id() })).await?;

    assert_eq!(after_unsupported["treasury_balance"], "0");
    assert_eq!(owner_balance_after, owner_balance_before);
    assert_eq!(treasury_token_balance, "0");

    Ok(())
}


#[tokio::test]
async fn sandbox_rejects_external_callback_invocation() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let token = worker.dev_create_account().await?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    // Exercise NEAR's generated #[private] check through the deployed entry point.
    let result = owner
        .call(treasury.id(), "on_transfer_complete")
        .args_json(json!({ "transfer_id": 0 }))
        .transact()
        .await?;

    assert!(result.into_result().is_err());
    Ok(())
}


#[tokio::test]
async fn sandbox_rejects_malformed_payment_account_id() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let token = worker.dev_create_account().await?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    let result = agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": "NOT A VALID ACCOUNT",
            "amount": "10",
            "memo": null
        }))
        .transact()
        .await?;

    assert!(result.into_result().is_err());
    Ok(())
}

#[tokio::test]
async fn sandbox_failed_nep141_transfer_clears_pending_and_preserves_treasury() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    // Deliberately do not register this receiver with the NEP-141 token.
    // The token's ft_transfer must fail, exercising the real promise callback.
    let unregistered_recipient = worker.dev_create_account().await?;

    let token = worker.dev_deploy(TOKEN_WASM).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "10000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    register_token_account(&owner, &token, treasury.id().as_str()).await?;

    let deposit_result = owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "1000",
            "memo": "Fund treasury for failed-transfer test",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    deposit_result.into_result()?;

    let funded_position = view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(funded_position["treasury_balance"], "1000");
    assert_eq!(funded_position["spendable_balance"], "900");

    // The NEP-141 token rejects transfers to accounts that have not registered.
    // The treasury callback must handle that failed cross-contract receipt.
    let failed_payment_result = agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": unregistered_recipient.id(),
            "amount": "200",
            "memo": "Expected failed transfer"
        }))
        .max_gas()
        .transact()
        .await?;
    println!("Expected failed NEP-141 transfer outcome: {:#?}", failed_payment_result);
    failed_payment_result.into_result()?;

    let final_position = view_json(&treasury, "get_financial_position", json!({})).await?;
    let pending_transfers = view_json(&treasury, "get_pending_transfers", json!({})).await?;
    let actual_token_balance = view_json(
        &token,
        "ft_balance_of",
        json!({ "account_id": treasury.id() }),
    )
    .await?;

    // Failed transfer: ledger and real token balance remain intact; pending
    // reservation is removed so the funds become spendable again.
    assert_eq!(final_position["treasury_balance"], "1000");
    assert_eq!(final_position["pending_discretionary"], "0");
    assert_eq!(final_position["spendable_balance"], "900");
    assert_eq!(pending_transfers, json!([]));
    assert_eq!(actual_token_balance, "1000");

    Ok(())
}


#[tokio::test]
async fn sandbox_read_only_token_balance_audit_detects_unaccounted_surplus() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;

    let token = worker.dev_deploy(TOKEN_WASM).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "10000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    register_token_account(&owner, &token, treasury.id().as_str()).await?;

    owner
        .call(token.id(), "ft_transfer")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "250",
            "memo": "Unaccounted surplus for audit"
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let before = view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(before["treasury_balance"], "0");

    owner
        .call(treasury.id(), "refresh_token_balance_audit")
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let audit = view_json(&treasury, "get_token_balance_audit", json!({})).await?;
    let after = view_json(&treasury, "get_financial_position", json!({})).await?;

    assert_eq!(audit["audit_pending"], false);
    assert_eq!(audit["observed_token_balance"], "250");
    assert_eq!(audit["ledger_balance_at_observation"], "0");
    assert!(audit["observed_at_ns"].as_str().is_some());
    assert_eq!(after["treasury_balance"], "0");
    assert_eq!(after["spendable_balance"], "0");

    Ok(())
}


#[tokio::test]
async fn sandbox_balance_audit_matches_ledger_after_deposit_and_payment() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let vendor = worker.dev_create_account().await?;

    let token = worker.dev_deploy(TOKEN_WASM).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "10000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    register_token_account(&owner, &token, treasury.id().as_str()).await?;
    register_token_account(&owner, &token, vendor.id().as_str()).await?;

    owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "1000",
            "memo": "Accepted deposit",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "refresh_token_balance_audit")
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let after_deposit = view_json(&treasury, "get_token_balance_audit", json!({})).await?;
    assert_eq!(after_deposit["observed_token_balance"], "1000");
    assert_eq!(after_deposit["ledger_balance_at_observation"], "1000");

    agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": vendor.id(),
            "amount": "200",
            "memo": "Audit after completed payment"
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "refresh_token_balance_audit")
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let after_payment = view_json(&treasury, "get_token_balance_audit", json!({})).await?;
    let position = view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(after_payment["observed_token_balance"], "800");
    assert_eq!(after_payment["ledger_balance_at_observation"], "800");
    assert_eq!(position["treasury_balance"], "800");

    Ok(())
}

#[tokio::test]
async fn sandbox_only_owner_can_start_token_balance_audit() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let token = worker.dev_create_account().await?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;

    let result = agent
        .call(treasury.id(), "refresh_token_balance_audit")
        .max_gas()
        .transact()
        .await?;

    assert!(result.into_result().is_err());
    let audit = view_json(&treasury, "get_token_balance_audit", json!({})).await?;
    assert_eq!(audit["audit_pending"], false);
    assert_eq!(audit["observed_token_balance"], Value::Null);

    Ok(())
}


#[tokio::test]
async fn sandbox_owner_reconciles_only_audited_surplus_and_consumes_snapshot() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let token = worker.dev_deploy(TOKEN_WASM).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "10000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;
    register_token_account(&owner, &token, treasury.id().as_str()).await?;

    owner
        .call(token.id(), "ft_transfer")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "250",
            "memo": "Direct unaccounted surplus"
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "refresh_token_balance_audit")
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "reconcile_token_surplus")
        .args_json(json!({ "amount": "200" }))
        .transact()
        .await?
        .into_result()?;

    let position = view_json(&treasury, "get_financial_position", json!({})).await?;
    let audit = view_json(&treasury, "get_token_balance_audit", json!({})).await?;
    let actual = view_json(&token, "ft_balance_of", json!({ "account_id": treasury.id() })).await?;
    assert_eq!(position["treasury_balance"], "200");
    assert_eq!(position["spendable_balance"], "100");
    assert_eq!(actual, "250");
    assert_eq!(audit["observed_token_balance"], Value::Null);

    let replay = owner
        .call(treasury.id(), "reconcile_token_surplus")
        .args_json(json!({ "amount": "1" }))
        .transact()
        .await?;
    assert!(replay.into_result().is_err());

    owner
        .call(treasury.id(), "refresh_token_balance_audit")
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    owner
        .call(treasury.id(), "reconcile_token_surplus")
        .args_json(json!({ "amount": "50" }))
        .transact()
        .await?
        .into_result()?;

    let final_position = view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(final_position["treasury_balance"], "250");

    Ok(())
}

#[tokio::test]
async fn sandbox_deposit_invalidates_prior_surplus_audit() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let token = worker.dev_deploy(TOKEN_WASM).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "10000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?
        .into_result()?;

    let treasury = worker.dev_deploy(TREASURY_WASM).await?;
    treasury
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "token_id": token.id(),
            "agent_id": agent.id(),
            "max_per_transaction": "500",
            "safety_reserve": "100"
        }))
        .transact()
        .await?
        .into_result()?;
    register_token_account(&owner, &token, treasury.id().as_str()).await?;

    owner
        .call(token.id(), "ft_transfer")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "100",
            "memo": "Initial direct surplus"
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(treasury.id(), "refresh_token_balance_audit")
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "50",
            "memo": "New accounted deposit",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let stale = owner
        .call(treasury.id(), "reconcile_token_surplus")
        .args_json(json!({ "amount": "1" }))
        .transact()
        .await?;
    assert!(stale.into_result().is_err());

    let position = view_json(&treasury, "get_financial_position", json!({})).await?;
    let audit = view_json(&treasury, "get_token_balance_audit", json!({})).await?;
    assert_eq!(position["treasury_balance"], "50");
    assert_eq!(audit["observed_token_balance"], Value::Null);

    Ok(())
}
