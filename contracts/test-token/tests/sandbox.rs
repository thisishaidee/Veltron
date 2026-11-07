use near_workspaces::{Contract, Worker};
use serde_json::json;

const TOKEN_WASM: &[u8] =
    include_bytes!("../../../target/wasm32-unknown-unknown/release/veltron_test_token.wasm");

async fn view_json(
    contract: &Contract,
    method: &str,
    args: serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    Ok(contract.call(method).args_json(args).view().await?.json()?)
}

async fn measure_initializer<W: Worker>(worker: &W) -> anyhow::Result<()> {
    let owner = worker.dev_create_account().await?;
    let token = worker.dev_deploy(TOKEN_WASM).await?;

    let initialization = owner
        .call(token.id(), "new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": "1000000000000",
            "metadata": {
                "spec": "ft-1.0.0",
                "name": "VELTRON Test Token",
                "symbol": "VTT",
                "decimals": 6
            }
        }))
        .transact()
        .await?;

    initialization.clone().into_result()?;

    let receipt_gas: u64 = initialization
        .receipt_outcomes()
        .iter()
        .map(|receipt| receipt.gas_burnt.as_gas())
        .sum();

    println!(
        "VELTRON token initializer receipt gas: {} Tgas ({} gas units)",
        receipt_gas as f64 / 1_000_000_000_000.0,
        receipt_gas
    );
    println!(
        "VELTRON token initializer execution outcome: {:#?}",
        initialization
    );

    let metadata = view_json(&token, "ft_metadata", json!({})).await?;
    let total_supply = view_json(&token, "ft_total_supply", json!({})).await?;
    let owner_balance = view_json(
        &token,
        "ft_balance_of",
        json!({ "account_id": owner.id() }),
    )
    .await?;

    assert_eq!(metadata["spec"], "ft-1.0.0");
    assert_eq!(metadata["name"], "VELTRON Test Token");
    assert_eq!(metadata["symbol"], "VTT");
    assert_eq!(metadata["decimals"], 6);
    assert_eq!(total_supply, "1000000000000");
    assert_eq!(owner_balance, "1000000000000");
    assert!(receipt_gas > 0, "initializer should consume measurable receipt gas");

    Ok(())
}

#[tokio::test]
async fn sandbox_measures_approved_token_initializer_and_verifies_supply() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    measure_initializer(&worker).await
}
