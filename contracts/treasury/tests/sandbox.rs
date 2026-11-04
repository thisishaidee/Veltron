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

    owner
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": treasury.id(),
            "amount": "1000",
            "memo": "Initial treasury funding",
            "msg": ""
        }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let funded_position = view_json(&treasury, "get_financial_position", json!({})).await?;
    assert_eq!(funded_position["treasury_balance"], "1000");
    assert_eq!(funded_position["spendable_balance"], "900");

    agent
        .call(treasury.id(), "request_payment")
        .args_json(json!({
            "recipient_id": vendor.id(),
            "amount": "200",
            "memo": "Sandbox vendor payment"
        }))
        .transact()
        .await?
        .into_result()?;

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
