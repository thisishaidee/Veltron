use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};
use std::task::Poll;

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
    for log in &success_callback_receipt.logs {
        if log.starts_with("VELTRON_GAS_PHASE:") {
            println!("{}", log);
        }
    }
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

#[tokio::test]
async fn sandbox_measures_storage_for_maximum_size_commitments() -> anyhow::Result<()> {
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
            "safety_reserve": "0"
        }))
        .transact()
        .await?
        .into_result()?;

    register_token_account(&owner, &token, treasury.id().as_str()).await?;

    owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "1000",
            "memo": "Fund maximum commitment storage measurement",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    // Measure after deployment, initialization, token registration and funding,
    // so the delta isolates storage added by the commitment records and index.
    let storage_before = treasury.view_account().await?.storage_usage;

    // 64-byte unique IDs, 64-byte valid recipient AccountId, and 256-byte
    // descriptions exercise the configured maximum input sizes.
    let recipient_id = format!("{}.near", "a".repeat(59));
    let description = "d".repeat(256);

    for index in 0..256 {
        let id = format!("{index:03}{}", "i".repeat(61));
        assert_eq!(id.len(), 64);

        owner
            .call(treasury.id(), "create_commitment")
            .args_json(json!({
                "id": id,
                "recipient_id": recipient_id,
                "amount": "1",
                "description": description
            }))
            .transact()
            .await?
            .into_result()?;
    }

    let storage_after = treasury.view_account().await?.storage_usage;
    let storage_delta = storage_after
        .checked_sub(storage_before)
        .expect("storage usage should not decrease after adding commitments");

    println!("Storage before 256 maximum-size commitments: {storage_before} bytes");
    println!("Storage after 256 maximum-size commitments: {storage_after} bytes");
    println!("Storage added by 256 maximum-size commitments: {storage_delta} bytes");
    println!(
        "Average added storage per maximum-size commitment: {:.2} bytes",
        storage_delta as f64 / 256.0
    );

    assert!(storage_delta > 0, "commitments should consume persistent storage");
    let position = view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(position["active_commitments"], "256");

    Ok(())
}


#[tokio::test]
async fn sandbox_commitment_cancellation_and_settlement_release_storage() -> anyhow::Result<()> {
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
            "safety_reserve": "0"
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
            "memo": "Fund commitment storage lifecycle test",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let storage_baseline = treasury.view_account().await?.storage_usage;
    let description = "d".repeat(256);

    owner
        .call(treasury.id(), "create_commitment")
        .args_json(json!({
            "id": "cancel-storage-record",
            "recipient_id": vendor.id(),
            "amount": "200",
            "description": description
        }))
        .transact()
        .await?
        .into_result()?;

    let after_cancelled_commitment_created =
        treasury.view_account().await?.storage_usage;

    owner
        .call(treasury.id(), "cancel_commitment")
        .args_json(json!({ "id": "cancel-storage-record" }))
        .transact()
        .await?
        .into_result()?;

    let after_cancellation = treasury.view_account().await?.storage_usage;
    println!("Storage baseline before commitment: {storage_baseline} bytes");
    println!(
        "Storage after commitment creation: {after_cancelled_commitment_created} bytes"
    );
    println!("Storage after cancellation: {after_cancellation} bytes");
    assert!(
        after_cancellation < after_cancelled_commitment_created,
        "cancelling a commitment should release its record and index storage"
    );

    owner
        .call(treasury.id(), "create_commitment")
        .args_json(json!({
            "id": "settle-storage-record",
            "recipient_id": vendor.id(),
            "amount": "200",
            "description": description
        }))
        .transact()
        .await?
        .into_result()?;

    let before_settlement = treasury.view_account().await?.storage_usage;

    let settlement = owner
        .call(treasury.id(), "settle_commitment")
        .args_json(json!({ "id": "settle-storage-record" }))
        .max_gas()
        .transact()
        .await?;
    settlement.into_result()?;

    let after_settlement = treasury.view_account().await?.storage_usage;
    println!("Storage before successful settlement: {before_settlement} bytes");
    println!("Storage after successful settlement callback: {after_settlement} bytes");
    assert!(
        after_settlement < before_settlement,
        "successful settlement should release commitment, index, lock and pending-transfer storage"
    );

    let position = view_json(&treasury, "get_financial_position", json!({})).await?;
    let pending = view_json(&treasury, "get_pending_transfers", json!({})).await?;
    assert_eq!(position["active_commitments"], "0");
    assert_eq!(pending, json!([]));

    Ok(())
}


#[tokio::test]
async fn sandbox_repeated_commitment_create_cancel_does_not_accumulate_storage() -> anyhow::Result<()> {
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
            "safety_reserve": "0"
        }))
        .transact()
        .await?
        .into_result()?;

    register_token_account(&owner, &token, treasury.id().as_str()).await?;
    owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "1000",
            "memo": "Fund repeated commitment storage test",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let baseline_storage = treasury.view_account().await?.storage_usage;
    let commitment_id = "reusable-storage-cycle";
    let description = "d".repeat(256);

    for cycle in 0..25 {
        owner
            .call(treasury.id(), "create_commitment")
            .args_json(json!({
                "id": commitment_id,
                "recipient_id": vendor.id(),
                "amount": "1",
                "description": description
            }))
            .transact()
            .await?
            .into_result()?;

        let after_create = treasury.view_account().await?.storage_usage;
        assert!(
            after_create > baseline_storage,
            "cycle {cycle}: creating a commitment should increase storage"
        );

        owner
            .call(treasury.id(), "cancel_commitment")
            .args_json(json!({ "id": commitment_id }))
            .transact()
            .await?
            .into_result()?;

        let after_cancel = treasury.view_account().await?.storage_usage;
        println!(
            "Commitment storage cycle {cycle}: baseline={baseline_storage}, after_create={after_create}, after_cancel={after_cancel}"
        );
        assert!(
            after_cancel <= baseline_storage,
            "cycle {cycle}: storage grew after cancellation (baseline {baseline_storage}, current {after_cancel})"
        );

        let position = view_json(&treasury, "get_financial_position", json!({})).await?;
        let commitments =
            view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 50 })).await?;
        assert_eq!(position["active_commitments"], "0");
        assert_eq!(commitments["commitments"].as_array().unwrap().len(), 0);
    }

    Ok(())
}

#[tokio::test]
async fn sandbox_agent_cannot_spend_committed_funds_and_owner_can_settle() -> anyhow::Result<()> {
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
            "max_per_transaction": "800",
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
            "memo": "Fund commitment protection scenario",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "create_commitment")
        .args_json(json!({
            "id": "protected-invoice",
            "recipient_id": vendor.id(),
            "amount": "300",
            "description": "Funds reserved for a vendor obligation"
        }))
        .transact()
        .await?
        .into_result()?;

    let protected_position =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(protected_position["treasury_balance"], "1000");
    assert_eq!(protected_position["active_commitments"], "300");
    assert_eq!(protected_position["safety_reserve"], "100");
    assert_eq!(protected_position["spendable_balance"], "600");

    // The agent's transaction cap permits 700, but only 600 is spendable.
    // This request must fail because the commitment and reserve are protected.
    let blocked_payment = agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": vendor.id(),
            "amount": "700",
            "memo": "Must not consume committed funds"
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(blocked_payment.into_result().is_err());

    let after_blocked_payment =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    let pending_after_block =
        view_json(&treasury, "get_pending_transfers", json!({})).await?;
    assert_eq!(after_blocked_payment["treasury_balance"], "1000");
    assert_eq!(after_blocked_payment["active_commitments"], "300");
    assert_eq!(after_blocked_payment["pending_discretionary"], "0");
    assert_eq!(after_blocked_payment["spendable_balance"], "600");
    assert_eq!(pending_after_block, json!([]));

    // The owner can settle the obligation through the real NEP-141 transfer
    // and callback. The commitment is removed only after successful settlement.
    let settlement = owner
        .call(treasury.id(), "settle_commitment")
        .args_json(json!({ "id": "protected-invoice" }))
        .max_gas()
        .transact()
        .await?;
    settlement.clone().into_result()?;
    assert!(
        settlement.receipt_outcomes().iter().any(|receipt| {
            receipt.logs.iter().any(|log| log == "VELTRON_TRANSFER_SUCCESS:0")
        }),
        "successful commitment settlement callback must be present"
    );

    let final_position =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    let final_commitments =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 25 })).await?;
    let final_pending =
        view_json(&treasury, "get_pending_transfers", json!({})).await?;
    let vendor_balance =
        view_json(&token, "ft_balance_of", json!({ "account_id": vendor.id() })).await?;

    assert_eq!(final_position["treasury_balance"], "700");
    assert_eq!(final_position["active_commitments"], "0");
    assert_eq!(final_position["pending_discretionary"], "0");
    assert_eq!(final_position["spendable_balance"], "600");
    assert_eq!(final_commitments["commitments"], json!([]));
    assert_eq!(final_pending, json!([]));
    assert_eq!(vendor_balance, "300");

    Ok(())
}

#[tokio::test]
async fn sandbox_paused_treasury_rejects_agent_payment_without_state_change() -> anyhow::Result<()> {
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
            "memo": "Fund pause protection test",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let before = view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(before["treasury_balance"], "1000");
    assert_eq!(before["spendable_balance"], "900");

    owner
        .call(treasury.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?
        .into_result()?;

    let paused = view_json(&treasury, "get_pause_status", json!({})).await?;
    assert_eq!(paused, true);

    let rejected_payment = agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": vendor.id(),
            "amount": "200",
            "memo": "Must be blocked while paused"
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(
        rejected_payment.into_result().is_err(),
        "agent payment must fail while the treasury is paused"
    );

    let after = view_json(&treasury, "get_financial_position", json!({})).await?;
    let pending = view_json(&treasury, "get_pending_transfers", json!({})).await?;
    let vendor_balance =
        view_json(&token, "ft_balance_of", json!({ "account_id": vendor.id() })).await?;

    assert_eq!(after["treasury_balance"], "1000");
    assert_eq!(after["spendable_balance"], "900");
    assert_eq!(after["pending_discretionary"], "0");
    assert_eq!(pending, json!([]));
    assert_eq!(vendor_balance, "0");

    Ok(())
}


#[tokio::test]
async fn sandbox_only_owner_can_pause_and_unpause_treasury() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
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

    // Neither the configured agent nor an unrelated account may activate
    // the emergency pause.
    let agent_pause_attempt = agent
        .call(treasury.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?;
    assert!(agent_pause_attempt.into_result().is_err());
    assert_eq!(
        view_json(&treasury, "get_pause_status", json!({})).await?,
        false
    );

    let attacker_pause_attempt = attacker
        .call(treasury.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?;
    assert!(attacker_pause_attempt.into_result().is_err());
    assert_eq!(
        view_json(&treasury, "get_pause_status", json!({})).await?,
        false
    );

    // The owner can activate the pause, but neither non-owner can reverse it.
    owner
        .call(treasury.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view_json(&treasury, "get_pause_status", json!({})).await?,
        true
    );

    let agent_unpause_attempt = agent
        .call(treasury.id(), "set_paused")
        .args_json(json!({ "paused": false }))
        .transact()
        .await?;
    assert!(agent_unpause_attempt.into_result().is_err());
    assert_eq!(
        view_json(&treasury, "get_pause_status", json!({})).await?,
        true
    );

    let attacker_unpause_attempt = attacker
        .call(treasury.id(), "set_paused")
        .args_json(json!({ "paused": false }))
        .transact()
        .await?;
    assert!(attacker_unpause_attempt.into_result().is_err());
    assert_eq!(
        view_json(&treasury, "get_pause_status", json!({})).await?,
        true
    );

    // Only the owner can restore outgoing-transfer availability.
    owner
        .call(treasury.id(), "set_paused")
        .args_json(json!({ "paused": false }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        view_json(&treasury, "get_pause_status", json!({})).await?,
        false
    );

    Ok(())
}

#[tokio::test]
async fn sandbox_agent_cannot_spend_commitment_reserved_funds() -> anyhow::Result<()> {
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
            "max_per_transaction": "700",
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
            "memo": "Fund commitment protection test",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "create_commitment")
        .args_json(json!({
            "id": "protected-invoice",
            "recipient_id": vendor.id(),
            "amount": "300",
            "description": "Funds reserved for a vendor obligation"
        }))
        .transact()
        .await?
        .into_result()?;

    // Balance 1,000 - commitment 300 - reserve 100 = 600 spendable.
    // The 601 request is below the 700 per-transaction cap, so only the
    // commitment-aware spendable-balance check should reject it.
    let over_commitment_request = agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": vendor.id(),
            "amount": "601",
            "memo": "Must not consume committed funds"
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(over_commitment_request.into_result().is_err());

    let after_rejection = view_json(&treasury, "get_financial_position", json!({})).await?;
    let pending_after_rejection =
        view_json(&treasury, "get_pending_transfers", json!({})).await?;
    let vendor_after_rejection =
        view_json(&token, "ft_balance_of", json!({ "account_id": vendor.id() })).await?;
    let commitments_after_rejection =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 25 })).await?;

    assert_eq!(after_rejection["treasury_balance"], "1000");
    assert_eq!(after_rejection["active_commitments"], "300");
    assert_eq!(after_rejection["safety_reserve"], "100");
    assert_eq!(after_rejection["spendable_balance"], "600");
    assert_eq!(after_rejection["pending_discretionary"], "0");
    assert_eq!(pending_after_rejection, json!([]));
    assert_eq!(vendor_after_rejection, "0");
    assert_eq!(
        commitments_after_rejection["commitments"][0]["id"],
        "protected-invoice"
    );

    // The exact spendable amount is permitted; the commitment and reserve
    // remain fully covered after the real NEP-141 transfer callback completes.
    let boundary_payment = agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": vendor.id(),
            "amount": "600",
            "memo": "Spend only the uncommitted balance"
        }))
        .max_gas()
        .transact()
        .await?;
    boundary_payment.clone().into_result()?;
    let success_callback_receipt = boundary_payment
        .receipt_outcomes()
        .iter()
        .find(|receipt| receipt.logs.iter().any(|log| log == "VELTRON_TRANSFER_SUCCESS:0"))
        .expect("successful discretionary payment callback must be present");
    assert!(
        success_callback_receipt.gas_burnt.as_gas() < 5_000_000_000_000,
        "discretionary callback exceeded 5 Tgas"
    );

    let final_position = view_json(&treasury, "get_financial_position", json!({})).await?;
    let final_vendor_balance =
        view_json(&token, "ft_balance_of", json!({ "account_id": vendor.id() })).await?;
    let final_commitments =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 25 })).await?;
    let final_pending = view_json(&treasury, "get_pending_transfers", json!({})).await?;

    assert_eq!(final_position["treasury_balance"], "400");
    assert_eq!(final_position["active_commitments"], "300");
    assert_eq!(final_position["safety_reserve"], "100");
    assert_eq!(final_position["spendable_balance"], "0");
    assert_eq!(final_position["pending_discretionary"], "0");
    assert_eq!(final_vendor_balance, "600");
    assert_eq!(final_commitments["commitments"][0]["id"], "protected-invoice");
    assert_eq!(final_pending, json!([]));

    // A further one-token request cannot cross into the protected obligation.
    let final_overdraw_attempt = agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": vendor.id(),
            "amount": "1",
            "memo": "Must remain blocked"
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(final_overdraw_attempt.into_result().is_err());

    let after_final_rejection =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(after_final_rejection["treasury_balance"], "400");
    assert_eq!(after_final_rejection["active_commitments"], "300");
    assert_eq!(after_final_rejection["spendable_balance"], "0");

    Ok(())
}

#[tokio::test]
async fn sandbox_pause_blocks_commitment_settlement_without_losing_obligation() -> anyhow::Result<()> {
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
            "memo": "Fund paused settlement test",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "create_commitment")
        .args_json(json!({
            "id": "paused-invoice",
            "recipient_id": vendor.id(),
            "amount": "300",
            "description": "Invoice retained while emergency pause is active"
        }))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?
        .into_result()?;

    // The emergency pause must block even owner-authorized settlement.
    let blocked_settlement = owner
        .call(treasury.id(), "settle_commitment")
        .args_json(json!({ "id": "paused-invoice" }))
        .max_gas()
        .transact()
        .await?;
    assert!(blocked_settlement.into_result().is_err());

    let while_paused = view_json(&treasury, "get_financial_position", json!({})).await?;
    let pending_while_paused =
        view_json(&treasury, "get_pending_transfers", json!({})).await?;
    let vendor_while_paused =
        view_json(&token, "ft_balance_of", json!({ "account_id": vendor.id() })).await?;
    let commitments_while_paused =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 25 })).await?;

    assert_eq!(view_json(&treasury, "get_pause_status", json!({})).await?, true);
    assert_eq!(while_paused["treasury_balance"], "1000");
    assert_eq!(while_paused["active_commitments"], "300");
    assert_eq!(while_paused["spendable_balance"], "600");
    assert_eq!(while_paused["pending_discretionary"], "0");
    assert_eq!(pending_while_paused, json!([]));
    assert_eq!(vendor_while_paused, "0");
    assert_eq!(commitments_while_paused["commitments"][0]["id"], "paused-invoice");
    assert_eq!(
        commitments_while_paused["commitments"][0]["settlement_pending"],
        false
    );

    // Once the owner lifts the pause, the same obligation remains settleable.
    owner
        .call(treasury.id(), "set_paused")
        .args_json(json!({ "paused": false }))
        .transact()
        .await?
        .into_result()?;

    let resumed_settlement = owner
        .call(treasury.id(), "settle_commitment")
        .args_json(json!({ "id": "paused-invoice" }))
        .max_gas()
        .transact()
        .await?;
    resumed_settlement.clone().into_result()?;
    let callback_receipt = resumed_settlement
        .receipt_outcomes()
        .iter()
        .find(|receipt| receipt.logs.iter().any(|log| log == "VELTRON_TRANSFER_SUCCESS:0"))
        .expect("settlement callback must succeed after owner unpauses treasury");
    assert!(
        callback_receipt.gas_burnt.as_gas() < 5_000_000_000_000,
        "commitment settlement callback exceeded 5 Tgas"
    );

    let final_position = view_json(&treasury, "get_financial_position", json!({})).await?;
    let final_vendor_balance =
        view_json(&token, "ft_balance_of", json!({ "account_id": vendor.id() })).await?;
    let final_commitments =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 25 })).await?;
    let final_pending = view_json(&treasury, "get_pending_transfers", json!({})).await?;

    assert_eq!(view_json(&treasury, "get_pause_status", json!({})).await?, false);
    assert_eq!(final_position["treasury_balance"], "700");
    assert_eq!(final_position["active_commitments"], "0");
    assert_eq!(final_position["spendable_balance"], "600");
    assert_eq!(final_position["pending_discretionary"], "0");
    assert_eq!(final_vendor_balance, "300");
    assert_eq!(final_commitments["commitments"].as_array().unwrap().len(), 0);
    assert_eq!(final_pending, json!([]));

    Ok(())
}


#[tokio::test]
async fn sandbox_only_owner_can_update_or_cancel_commitments_and_totals_reconcile() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let vendor = worker.dev_create_account().await?;
    let replacement_vendor = worker.dev_create_account().await?;

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
    register_token_account(&owner, &token, replacement_vendor.id().as_str()).await?;

    owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "1000",
            "memo": "Fund commitment administration test",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "create_commitment")
        .args_json(json!({
            "id": "admin-invoice",
            "recipient_id": vendor.id(),
            "amount": "300",
            "description": "Original vendor obligation"
        }))
        .transact()
        .await?
        .into_result()?;

    // The configured agent and an unrelated account cannot rewrite or erase
    // an obligation. Failed calls must leave both the record and total intact.
    for unauthorized in [&agent, &attacker] {
        let update = unauthorized
            .call(treasury.id(), "update_commitment")
            .args_json(json!({
                "id": "admin-invoice",
                "recipient_id": replacement_vendor.id(),
                "amount": "1",
                "description": "Unauthorized rewrite"
            }))
            .transact()
            .await?;
        assert!(update.into_result().is_err());

        let cancel = unauthorized
            .call(treasury.id(), "cancel_commitment")
            .args_json(json!({ "id": "admin-invoice" }))
            .transact()
            .await?;
        assert!(cancel.into_result().is_err());
    }

    let after_unauthorized_attempts =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    let original_commitment =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 25 })).await?;
    assert_eq!(after_unauthorized_attempts["treasury_balance"], "1000");
    assert_eq!(after_unauthorized_attempts["active_commitments"], "300");
    assert_eq!(after_unauthorized_attempts["spendable_balance"], "600");
    assert_eq!(original_commitment["commitments"][0]["recipient_id"], vendor.id().as_str());
    assert_eq!(original_commitment["commitments"][0]["amount"], "300");

    // The owner may deliberately revise the obligation; the aggregate ledger
    // must move from 300 to 400 and spendable funds must fall by exactly 100.
    owner
        .call(treasury.id(), "update_commitment")
        .args_json(json!({
            "id": "admin-invoice",
            "recipient_id": replacement_vendor.id(),
            "amount": "400",
            "description": "Revised vendor obligation"
        }))
        .transact()
        .await?
        .into_result()?;

    let after_owner_update =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    let updated_commitment =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 25 })).await?;
    assert_eq!(after_owner_update["treasury_balance"], "1000");
    assert_eq!(after_owner_update["active_commitments"], "400");
    assert_eq!(after_owner_update["spendable_balance"], "500");
    assert_eq!(updated_commitment["commitments"][0]["recipient_id"], replacement_vendor.id().as_str());
    assert_eq!(updated_commitment["commitments"][0]["amount"], "400");
    assert_eq!(updated_commitment["commitments"][0]["description"], "Revised vendor obligation");

    // Owner cancellation releases exactly the revised commitment, not the
    // safety reserve, and removes the indexed record.
    owner
        .call(treasury.id(), "cancel_commitment")
        .args_json(json!({ "id": "admin-invoice" }))
        .transact()
        .await?
        .into_result()?;

    let after_owner_cancel =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    let commitments_after_cancel =
        view_json(&treasury, "get_commitments", json!({ "from_id": null, "limit": 25 })).await?;
    assert_eq!(after_owner_cancel["treasury_balance"], "1000");
    assert_eq!(after_owner_cancel["active_commitments"], "0");
    assert_eq!(after_owner_cancel["safety_reserve"], "100");
    assert_eq!(after_owner_cancel["spendable_balance"], "900");
    assert_eq!(commitments_after_cancel["commitments"], json!([]));

    Ok(())
}


#[tokio::test]
async fn sandbox_safety_reserve_is_owner_only_and_cannot_make_treasury_insolvent() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
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
            "memo": "Fund safety reserve boundary test",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(treasury.id(), "create_commitment")
        .args_json(json!({
            "id": "reserve-test-invoice",
            "recipient_id": vendor.id(),
            "amount": "300",
            "description": "Obligation protected during reserve changes"
        }))
        .transact()
        .await?
        .into_result()?;

    // The agent and an unrelated account cannot alter the reserve.
    for unauthorized in [&agent, &attacker] {
        let attempt = unauthorized
            .call(treasury.id(), "set_safety_reserve")
            .args_json(json!({ "amount": "1" }))
            .transact()
            .await?;
        assert!(attempt.into_result().is_err());
    }

    let after_unauthorized =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(after_unauthorized["treasury_balance"], "1000");
    assert_eq!(after_unauthorized["active_commitments"], "300");
    assert_eq!(after_unauthorized["safety_reserve"], "100");
    assert_eq!(after_unauthorized["spendable_balance"], "600");

    // A reserve of 701 would require 1,001 tokens to cover the 300
    // commitment plus reserve, so the owner update must revert atomically.
    let insolvent_reserve = owner
        .call(treasury.id(), "set_safety_reserve")
        .args_json(json!({ "amount": "701" }))
        .transact()
        .await?;
    assert!(insolvent_reserve.into_result().is_err());

    let after_insolvent_attempt =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(after_insolvent_attempt["treasury_balance"], "1000");
    assert_eq!(after_insolvent_attempt["active_commitments"], "300");
    assert_eq!(after_insolvent_attempt["safety_reserve"], "100");
    assert_eq!(after_insolvent_attempt["spendable_balance"], "600");

    // A solvent owner-selected reserve is accepted and the spendable
    // balance is recalculated from balance - commitments - reserve.
    owner
        .call(treasury.id(), "set_safety_reserve")
        .args_json(json!({ "amount": "200" }))
        .transact()
        .await?
        .into_result()?;

    let after_valid_update =
        view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(after_valid_update["treasury_balance"], "1000");
    assert_eq!(after_valid_update["active_commitments"], "300");
    assert_eq!(after_valid_update["safety_reserve"], "200");
    assert_eq!(after_valid_update["spendable_balance"], "500");

    Ok(())
}
