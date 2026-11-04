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
    payment_result.into_result()?;

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
