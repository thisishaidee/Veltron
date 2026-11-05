use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::collections::{LookupMap, TreeMap, UnorderedSet};

const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const BALANCE_QUERY_GAS: Gas = Gas::from_tgas(5);
const MAX_COMMITMENT_ID_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 256;
const MAX_PAYMENT_MEMO_LENGTH: usize = 256;
const MAX_COMMITMENTS: usize = 256;
const MAX_PENDING_TRANSFERS: usize = 64;
const DEFAULT_COMMITMENT_PAGE_SIZE: u32 = 25;
const MAX_COMMITMENT_PAGE_SIZE: u32 = 50;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Commitment {
    pub id: String,
    pub recipient_id: AccountId,
    pub amount: u128,
    pub description: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub enum PendingKind {
    Discretionary { recipient_id: AccountId, memo: Option<String> },
    CommitmentSettlement { commitment_id: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PendingTransfer {
    pub id: u64,
    pub amount: u128,
    pub kind: PendingKind,
    pub created_at_ns: u64,
}

#[near(serializers = [json])]
pub struct PendingTransferView {
    pub id: U64,
    pub amount: U128,
    pub kind: PendingKind,
    pub created_at_ns: U64,
}

#[near(serializers = [json])]
pub struct FinancialPosition {
    pub treasury_balance: U128,
    pub active_commitments: U128,
    pub safety_reserve: U128,
    pub pending_discretionary: U128,
    pub spendable_balance: U128,
}

#[near(serializers = [json])]
pub struct TokenBalanceAudit {
    pub audit_pending: bool,
    pub observed_token_balance: Option<U128>,
    pub ledger_balance_at_observation: Option<U128>,
    pub observed_at_ns: Option<U64>,
}

#[near(serializers = [json])]
pub struct CommitmentPage {
    pub commitments: Vec<CommitmentView>,
    pub next_cursor: Option<String>,
}

#[near(serializers = [json])]
pub struct CommitmentView {
    pub id: String,
    pub recipient_id: AccountId,
    pub amount: U128,
    pub description: String,
    pub settlement_pending: bool,
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[ext_contract(ext_self)]
pub trait VeltronCallbacks {
    fn on_transfer_complete(
        &mut self,
        transfer_id: u64,
        #[callback_result] result: Result<(), PromiseError>,
    );
    fn on_balance_audit_complete(
        &mut self,
        #[callback_result] result: Result<U128, PromiseError>,
    );
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Veltron {
    owner_id: AccountId,
    token_id: AccountId,
    agent_id: AccountId,
    max_per_transaction: u128,
    treasury_balance: u128,
    safety_reserve: u128,
    next_transfer_id: u64,
    commitments: LookupMap<String, Commitment>,
    commitment_ids: UnorderedSet<String>,
    active_commitments_total: u128,
    pending: TreeMap<u64, PendingTransfer>,
    settlement_pending: LookupMap<String, bool>,
    balance_audit_pending: bool,
    paused: bool,
    observed_token_balance: Option<u128>,
    ledger_balance_at_observation: Option<u128>,
    balance_observed_at_ns: Option<u64>,
}

#[near]
impl Veltron {
    #[init]
    pub fn new(
        owner_id: AccountId,
        token_id: AccountId,
        agent_id: AccountId,
        max_per_transaction: U128,
        safety_reserve: U128,
    ) -> Self {
        let treasury_id = env::current_account_id();
        require!(owner_id != treasury_id, "Owner cannot be treasury contract");
        require!(agent_id != treasury_id, "Agent cannot be treasury contract");
        require!(token_id != treasury_id, "Token contract cannot be treasury contract");
        require!(owner_id != token_id, "Owner and token contract must differ");
        require!(agent_id != token_id, "Agent and token contract must differ");
        require!(owner_id != agent_id, "Owner and agent must differ");
        require!(max_per_transaction.0 > 0, "Transaction limit must be positive");
        Self {
            owner_id,
            token_id,
            agent_id,
            max_per_transaction: max_per_transaction.0,
            treasury_balance: 0,
            safety_reserve: safety_reserve.0,
            next_transfer_id: 0,
            commitments: LookupMap::new(&b"veltron_commitments"[..]),
            commitment_ids: UnorderedSet::new(&b"veltron_commitment_ids"[..]),
            active_commitments_total: 0,
            pending: TreeMap::new(&b"veltron_pending"[..]),
            settlement_pending: LookupMap::new(&b"veltron_settlement_pending"[..]),
            balance_audit_pending: false,
            paused: false,
            observed_token_balance: None,
            ledger_balance_at_observation: None,
            balance_observed_at_ns: None,
        }
    }

    /// NEP-141 receiver. Only the configured token contract can credit the ledger.
    /// The contract accepts the full transfer; unsupported msg formats are rejected.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = sender_id;
        env::log_str("VELTRON_DEPOSIT: entered ft_on_transfer");
        let predecessor = env::predecessor_account_id();
        env::log_str(&format!("VELTRON_DEPOSIT: predecessor={}", predecessor));
        env::log_str(&format!("VELTRON_DEPOSIT: configured_token={}", self.token_id));
        require!(predecessor == self.token_id, "Untrusted token contract");
        require!(!self.balance_audit_pending, "Token balance audit in progress");

        env::log_str(&format!("VELTRON_DEPOSIT: msg_empty={}", msg.is_empty()));
        require!(msg.is_empty(), "Unsupported deposit message");

        env::log_str(&format!("VELTRON_DEPOSIT: amount={}", amount.0));
        require!(amount.0 > 0, "Deposit amount must be positive");

        env::log_str(&format!("VELTRON_DEPOSIT: balance_before={}", self.treasury_balance));
        self.invalidate_balance_audit();
        self.treasury_balance = self.treasury_balance.checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("Treasury balance overflow"));
        env::log_str(&format!("VELTRON_DEPOSIT: balance_after={}", self.treasury_balance));
        PromiseOrValue::Value(U128(0))
    }

    pub fn create_commitment(
        &mut self,
        id: String,
        recipient_id: AccountId,
        amount: U128,
        description: String,
    ) {
        self.assert_owner();
        require!(!id.is_empty(), "Commitment ID cannot be empty");
        require!(id.len() <= MAX_COMMITMENT_ID_LENGTH, "Commitment ID is too long");
        require!(recipient_id != env::current_account_id(), "Commitment recipient cannot be treasury");
        require!(recipient_id != self.token_id, "Commitment recipient cannot be token contract");
        require!(!self.commitments.contains_key(&id), "Commitment already exists");
        require!(self.commitment_ids.len() < MAX_COMMITMENTS as u64, "Maximum active commitments reached");
        require!(amount.0 > 0, "Commitment amount must be positive");
        require!(description.len() <= MAX_DESCRIPTION_LENGTH, "Description is too long");
        let new_total = self.active_commitments_total.checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("Commitment total overflow"));
        self.commitments.insert(&id, &Commitment {
            id: id.clone(),
            recipient_id,
            amount: amount.0,
            description,
        });
        require!(self.commitment_ids.insert(&id), "Commitment index already exists");
        self.active_commitments_total = new_total;
        self.assert_solvent();
    }

    pub fn update_commitment(
        &mut self,
        id: String,
        recipient_id: AccountId,
        amount: U128,
        description: String,
    ) {
        self.assert_owner();
        require!(amount.0 > 0, "Commitment amount must be positive");
        require!(description.len() <= 256, "Description is too long");
        require!(recipient_id != env::current_account_id(), "Commitment recipient cannot be treasury");
        require!(recipient_id != self.token_id, "Commitment recipient cannot be token contract");
        require!(!self.settlement_pending.get(&id).unwrap_or(false),
            "Cannot update a commitment while settlement is pending");
        let mut commitment = self.commitments.get(&id)
            .unwrap_or_else(|| env::panic_str("Commitment not found"));
        let new_total = self.active_commitments_total
            .checked_sub(commitment.amount)
            .and_then(|total| total.checked_add(amount.0))
            .unwrap_or_else(|| env::panic_str("Commitment total overflow"));
        commitment.recipient_id = recipient_id;
        commitment.amount = amount.0;
        commitment.description = description;
        self.commitments.insert(&id, &commitment);
        self.active_commitments_total = new_total;
        self.assert_solvent();
    }

    pub fn cancel_commitment(&mut self, id: String) {
        self.assert_owner();
        require!(!self.settlement_pending.get(&id).unwrap_or(false),
            "Cannot cancel a commitment while settlement is pending");
        let removed = self.commitments.remove(&id).unwrap_or_else(|| env::panic_str("Commitment not found"));
        require!(self.commitment_ids.remove(&id), "Commitment index entry not found");
        self.active_commitments_total = self.active_commitments_total.checked_sub(removed.amount)
            .unwrap_or_else(|| env::panic_str("Commitment total underflow"));
    }

    /// Emergency circuit breaker for new outgoing treasury transfers.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        env::log_str(if paused { "VELTRON_PAUSED" } else { "VELTRON_UNPAUSED" });
    }

    pub fn get_pause_status(&self) -> bool {
        self.paused
    }

    pub fn set_safety_reserve(&mut self, amount: U128) {
        self.assert_owner();
        self.safety_reserve = amount.0;
        self.assert_solvent();
    }

    pub fn set_agent(&mut self, agent_id: AccountId, max_per_transaction: U128) {
        self.assert_owner();
        require!(agent_id != self.owner_id, "Agent and owner must differ");
        require!(agent_id != env::current_account_id(), "Agent cannot be treasury contract");
        require!(agent_id != self.token_id, "Agent cannot be the token contract");
        require!(max_per_transaction.0 > 0, "Transaction limit must be positive");
        self.agent_id = agent_id;
        self.max_per_transaction = max_per_transaction.0;
    }

    /// Agent-controlled discretionary payment. Pending amounts remain reserved until callback.
    pub fn request_payment(
        &mut self,
        recipient_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> Promise {
        require!(env::predecessor_account_id() == self.agent_id, "Only the authorized agent");
        require!(!self.paused, "Treasury is paused");
        require!(amount.0 > 0, "Payment amount must be positive");
        require!(amount.0 <= self.max_per_transaction, "Per-transaction limit exceeded");
        require!(recipient_id != env::current_account_id(), "Cannot pay treasury to itself");
        require!(recipient_id != self.token_id, "Cannot pay the token contract");
        require!(memo.as_ref().map_or(true, |value| value.len() <= MAX_PAYMENT_MEMO_LENGTH), "Payment memo is too long");
        let position = self.calculate_position();
        require!(amount.0 <= position.spendable_balance.0, "Insufficient spendable balance");
        self.start_transfer(amount.0, PendingKind::Discretionary { recipient_id, memo })
    }

    /// Owner settles an existing obligation to its pre-committed recipient.
    pub fn settle_commitment(&mut self, id: String) -> Promise {
        self.assert_owner();
        require!(!self.paused, "Treasury is paused");
        require!(!self.settlement_pending.get(&id).unwrap_or(false),
            "Settlement already pending");
        let commitment = self.commitments.get(&id)
            .unwrap_or_else(|| env::panic_str("Commitment not found"))
            .clone();
        require!(commitment.amount <= self.treasury_balance, "Treasury balance is insufficient");
        self.settlement_pending.insert(&id, &true);
        self.start_transfer(
            commitment.amount,
            PendingKind::CommitmentSettlement { commitment_id: id },
        )
    }

    pub fn get_financial_position(&self) -> FinancialPosition {
        self.calculate_position()
    }

    /// Requests a read-only snapshot of the configured NEP-141 token balance.
    /// The result is observational only and never changes the internal ledger.
    pub fn refresh_token_balance_audit(&mut self) -> Promise {
        self.assert_owner();
        require!(!self.balance_audit_pending, "A token balance audit is already pending");
        require!(self.pending.is_empty(), "Cannot audit while transfers are pending");
        self.balance_audit_pending = true;
        ext_ft::ext(self.token_id.clone())
            .with_static_gas(BALANCE_QUERY_GAS)
            .ft_balance_of(env::current_account_id())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_balance_audit_complete()
            )
    }

    pub fn get_token_balance_audit(&self) -> TokenBalanceAudit {
        TokenBalanceAudit {
            audit_pending: self.balance_audit_pending,
            observed_token_balance: self.observed_token_balance.map(U128),
            ledger_balance_at_observation: self.ledger_balance_at_observation.map(U128),
            observed_at_ns: self.balance_observed_at_ns.map(U64),
        }
    }

    /// Credits only a caller-selected amount supported by the latest successful audit.
    /// The observation is consumed after one reconciliation.
    pub fn reconcile_token_surplus(&mut self, amount: U128) {
        self.assert_owner();
        require!(!self.balance_audit_pending, "Token balance audit in progress");
        require!(self.pending.is_empty(), "Cannot reconcile while transfers are pending");
        require!(amount.0 > 0, "Reconciliation amount must be positive");

        let observed_balance = self.observed_token_balance
            .unwrap_or_else(|| env::panic_str("A successful balance audit is required"));
        let observed_ledger = self.ledger_balance_at_observation
            .unwrap_or_else(|| env::panic_str("A successful balance audit is required"));
        require!(observed_ledger == self.treasury_balance,
            "Balance audit is stale; refresh it before reconciliation");
        require!(observed_balance > observed_ledger, "No token surplus was observed");
        let observed_surplus = observed_balance - observed_ledger;
        require!(amount.0 <= observed_surplus, "Amount exceeds observed token surplus");

        self.treasury_balance = self.treasury_balance.checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("Treasury balance overflow"));
        self.invalidate_balance_audit();
        self.assert_solvent();
        env::log_str(&format!("VELTRON_SURPLUS_RECONCILED:{}", amount.0));
    }

    #[private]
    pub fn on_balance_audit_complete(
        &mut self,
        #[callback_result] result: Result<U128, PromiseError>,
    ) {
        self.balance_audit_pending = false;
        match result {
            Ok(actual_balance) => {
                self.observed_token_balance = Some(actual_balance.0);
                self.ledger_balance_at_observation = Some(self.treasury_balance);
                self.balance_observed_at_ns = Some(env::block_timestamp());
                env::log_str("VELTRON_TOKEN_BALANCE_AUDIT: completed");
            }
            Err(_) => {
                env::log_str("VELTRON_TOKEN_BALANCE_AUDIT: failed");
            }
        }
    }

    /// Returns commitments after `from_id` (exclusive), with a bounded page size.
    /// Pass the previous page's `next_cursor` as `from_id` to fetch the next page.
    pub fn get_commitments(
        &self,
        from_id: Option<String>,
        limit: Option<u32>,
    ) -> CommitmentPage {
        let limit = limit.unwrap_or(DEFAULT_COMMITMENT_PAGE_SIZE);
        require!(limit > 0, "Page limit must be positive");
        let limit = limit.min(MAX_COMMITMENT_PAGE_SIZE) as usize;
        // The active set is capped at 256 entries. Sort IDs in memory to preserve
        // the API's lexicographic cursor order without a persistent AVL tree.
        let mut ids: Vec<String> = self.commitment_ids.iter().collect();
        ids.sort_unstable();
        let start = from_id
            .as_ref()
            .map(|cursor| ids.partition_point(|id| id <= cursor))
            .unwrap_or(0);
        let mut commitments: Vec<CommitmentView> = ids
            .into_iter()
            .skip(start)
            .take(limit + 1)
            .map(|id| {
                let c = self.commitments.get(&id)
                    .unwrap_or_else(|| env::panic_str("Commitment index points to missing record"));
                CommitmentView {
                    id: c.id.clone(),
                    recipient_id: c.recipient_id.clone(),
                    amount: U128(c.amount),
                    description: c.description.clone(),
                    settlement_pending: self.settlement_pending.get(&id).unwrap_or(false),
                }
            })
            .collect();
        let has_more = commitments.len() > limit;
        if has_more {
            commitments.pop();
        }
        let next_cursor = if has_more {
            commitments.last().map(|c| c.id.clone())
        } else {
            None
        };
        CommitmentPage { commitments, next_cursor }
    }

    /// Returns the bounded in-flight transfer list, including creation timestamps.
    /// A long-lived entry is a monitoring signal, not proof that the token transfer failed.
    pub fn get_pending_transfers(&self) -> Vec<PendingTransferView> {
        self.pending.iter().map(|(_, p)| PendingTransferView {
            id: U64(p.id),
            amount: U128(p.amount),
            kind: p.kind.clone(),
            created_at_ns: U64(p.created_at_ns),
        }).collect()
    }

    #[private]
    pub fn on_transfer_complete(
        &mut self,
        transfer_id: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let transfer = self.pending.remove(&transfer_id)
            .unwrap_or_else(|| env::panic_str("Pending transfer not found"));

        match result {
            Ok(()) => {
                require!(self.treasury_balance >= transfer.amount, "Treasury accounting underflow");
                self.treasury_balance -= transfer.amount;
                if let PendingKind::CommitmentSettlement { commitment_id } = transfer.kind {
                    let settled = self.commitments.remove(&commitment_id)
                        .unwrap_or_else(|| env::panic_str("Commitment not found during settlement callback"));
                    require!(self.commitment_ids.remove(&commitment_id), "Commitment index entry not found during settlement");
                    self.active_commitments_total = self.active_commitments_total.checked_sub(settled.amount)
                        .unwrap_or_else(|| env::panic_str("Commitment total underflow"));
                    self.settlement_pending.remove(&commitment_id);
                }
                env::log_str(&format!("VELTRON_TRANSFER_SUCCESS:{}", transfer_id));
            }
            Err(_) => {
                if let PendingKind::CommitmentSettlement { commitment_id } = transfer.kind {
                    self.settlement_pending.remove(&commitment_id);
                }
                env::log_str(&format!("VELTRON_TRANSFER_FAILED:{}", transfer_id));
            }
        }
    }
}

impl Veltron {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the treasury owner");
    }

    fn invalidate_balance_audit(&mut self) {
        self.observed_token_balance = None;
        self.ledger_balance_at_observation = None;
        self.balance_observed_at_ns = None;
    }

    fn pending_discretionary_total(&self) -> u128 {
        self.pending.iter().fold(0u128, |sum, (_, p)| {
            if matches!(p.kind, PendingKind::Discretionary { .. }) {
                sum.checked_add(p.amount).unwrap_or_else(|| env::panic_str("Pending total overflow"))
            } else {
                sum
            }
        })
    }

    fn active_commitment_total(&self) -> u128 {
        self.active_commitments_total
    }

    fn calculate_position(&self) -> FinancialPosition {
        let commitments = self.active_commitment_total();
        let pending = self.pending_discretionary_total();
        let reserved = commitments
            .checked_add(self.safety_reserve)
            .and_then(|v| v.checked_add(pending))
            .unwrap_or_else(|| env::panic_str("Reserved balance overflow"));
        let spendable = self.treasury_balance.saturating_sub(reserved);
        FinancialPosition {
            treasury_balance: U128(self.treasury_balance),
            active_commitments: U128(commitments),
            safety_reserve: U128(self.safety_reserve),
            pending_discretionary: U128(pending),
            spendable_balance: U128(spendable),
        }
    }

    fn assert_solvent(&self) {
        let reserved = self.active_commitment_total()
            .checked_add(self.safety_reserve)
            .and_then(|v| v.checked_add(self.pending_discretionary_total()))
            .unwrap_or_else(|| env::panic_str("Reserved balance overflow"));
        require!(reserved <= self.treasury_balance, "Commitments and reserve exceed treasury balance");
    }

    fn start_transfer(&mut self, amount: u128, kind: PendingKind) -> Promise {
        require!(!self.balance_audit_pending, "Token balance audit in progress");
        require!(self.pending.len() < MAX_PENDING_TRANSFERS as u64, "Maximum pending transfers reached");
        self.invalidate_balance_audit();
        let id = self.next_transfer_id;
        self.next_transfer_id = self.next_transfer_id.checked_add(1)
            .unwrap_or_else(|| env::panic_str("Transfer ID overflow"));
        let (recipient_id, memo) = match &kind {
            PendingKind::Discretionary { recipient_id, memo } => (recipient_id.clone(), memo.clone()),
            PendingKind::CommitmentSettlement { commitment_id } => {
                let c = self.commitments.get(commitment_id)
                    .unwrap_or_else(|| env::panic_str("Commitment not found"));
                (c.recipient_id.clone(), Some(format!("VELTRON commitment {}", commitment_id)))
            }
        };
        self.pending.insert(&id, &PendingTransfer {
            id,
            amount,
            kind,
            created_at_ns: env::block_timestamp(),
        });
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(recipient_id, U128(amount), memo)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_complete(id)
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn account(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn setup(predecessor: &str) -> Veltron {
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(account(predecessor));
        testing_env!(builder.build());
        Veltron::new(
            account("owner.near"),
            account("token.near"),
            account("agent.near"),
            U128(500),
            U128(100),
        )
    }



    #[test]
    #[should_panic(expected = "Owner and agent must differ")]
    fn rejects_owner_and_agent_sharing_one_account() {
        let _ = Veltron::new(
            account("owner.near"),
            account("token.near"),
            account("owner.near"),
            U128(500),
            U128(100),
        );
    }

    #[test]
    #[should_panic(expected = "Owner cannot be treasury contract")]
    fn rejects_treasury_as_owner_at_initialization() {
        let mut builder = VMContextBuilder::new();
        builder.current_account_id(account("treasury.near"));
        testing_env!(builder.build());
        let _ = Veltron::new(
            account("treasury.near"),
            account("token.near"),
            account("agent.near"),
            U128(500),
            U128(100),
        );
    }

    #[test]
    #[should_panic(expected = "Agent cannot be treasury contract")]
    fn rejects_treasury_as_agent_at_initialization() {
        let mut builder = VMContextBuilder::new();
        builder.current_account_id(account("treasury.near"));
        testing_env!(builder.build());
        let _ = Veltron::new(
            account("owner.near"),
            account("token.near"),
            account("treasury.near"),
            U128(500),
            U128(100),
        );
    }

    #[test]
    #[should_panic(expected = "Token contract cannot be treasury contract")]
    fn rejects_treasury_as_token_contract_at_initialization() {
        let mut builder = VMContextBuilder::new();
        builder.current_account_id(account("treasury.near"));
        testing_env!(builder.build());
        let _ = Veltron::new(
            account("owner.near"),
            account("treasury.near"),
            account("agent.near"),
            U128(500),
            U128(100),
        );
    }

    #[test]
    #[should_panic(expected = "Transaction limit must be positive")]
    fn rejects_zero_transaction_limit_at_initialization() {
        let _ = Veltron::new(
            account("owner.near"),
            account("token.near"),
            account("agent.near"),
            U128(0),
            U128(100),
        );
    }

    #[test]
    #[should_panic(expected = "Commitment recipient cannot be treasury")]
    fn rejects_commitment_to_treasury_itself() {
        let mut contract = setup("owner.near");
        let treasury_id = env::current_account_id();
        contract.create_commitment(
            "self-payment".to_string(),
            treasury_id,
            U128(100),
            "Invalid self-payment".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "Commitment recipient cannot be treasury")]
    fn rejects_updating_commitment_recipient_to_treasury() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "invoice-self-update".to_string(),
            account("vendor.near"),
            U128(100),
            "Vendor invoice".to_string(),
        );
        let treasury_id = env::current_account_id();
        contract.update_commitment(
            "invoice-self-update".to_string(),
            treasury_id,
            U128(100),
            "Invalid self-payment".to_string(),
        );
    }


    #[test]
    #[should_panic(expected = "Commitment recipient cannot be token contract")]
    fn rejects_commitment_to_configured_token_contract() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "token-recipient".to_string(),
            account("token.near"),
            U128(100),
            "Invalid token-contract recipient".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "Commitment recipient cannot be token contract")]
    fn rejects_updating_commitment_to_configured_token_contract() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "token-update".to_string(),
            account("vendor.near"),
            U128(100),
            "Vendor invoice".to_string(),
        );
        contract.update_commitment(
            "token-update".to_string(),
            account("token.near"),
            U128(100),
            "Invalid token-contract recipient".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "Cannot pay the token contract")]
    fn rejects_discretionary_payment_to_configured_token_contract() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(account("token.near"), U128(50), None);
    }

    #[test]
    #[should_panic(expected = "Commitment ID is too long")]
    fn rejects_oversized_commitment_id() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "x".repeat(MAX_COMMITMENT_ID_LENGTH + 1),
            account("vendor.near"),
            U128(100),
            "Vendor invoice".to_string(),
        );
    }

    #[test]
    fn initializes_with_zero_spendable_balance() {
        let contract = setup("owner.near");
        let p = contract.get_financial_position();
        assert_eq!(p.treasury_balance.0, 0);
        assert_eq!(p.spendable_balance.0, 0);
    }

    #[test]
    fn commitment_aggregate_tracks_create_update_cancel_and_settlement() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 2_000;
        contract.create_commitment("a".to_string(), account("a.near"), U128(200), "A".to_string());
        contract.create_commitment("b".to_string(), account("b.near"), U128(300), "B".to_string());
        assert_eq!(contract.get_financial_position().active_commitments.0, 500);

        contract.update_commitment("a".to_string(), account("a.near"), U128(250), "A revised".to_string());
        assert_eq!(contract.get_financial_position().active_commitments.0, 550);

        contract.cancel_commitment("b".to_string());
        assert_eq!(contract.get_financial_position().active_commitments.0, 250);

        contract.settle_commitment("a".to_string());
        callback_context();
        contract.on_transfer_complete(0, Ok(()));
        assert_eq!(contract.get_financial_position().active_commitments.0, 0);
    }

    #[test]
    fn commitment_id_can_be_reused_after_cancel_and_successful_settlement() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 2_000;

        contract.create_commitment(
            "reusable".to_string(),
            account("first-vendor.near"),
            U128(200),
            "First obligation".to_string(),
        );
        contract.cancel_commitment("reusable".to_string());

        assert_eq!(contract.get_financial_position().active_commitments.0, 0);
        assert!(contract.get_commitments(None, None).commitments.is_empty());

        // Cancellation removes both the record and active index entry.
        contract.create_commitment(
            "reusable".to_string(),
            account("second-vendor.near"),
            U128(300),
            "Second obligation".to_string(),
        );
        contract.settle_commitment("reusable".to_string());
        callback_context();
        contract.on_transfer_complete(0, Ok(()));

        assert_eq!(contract.get_financial_position().active_commitments.0, 0);
        assert!(contract.get_commitments(None, None).commitments.is_empty());

        // Successful settlement also frees the identifier for a new obligation.
        let mut owner_context = VMContextBuilder::new();
        owner_context.predecessor_account_id(account("owner.near"));
        testing_env!(owner_context.build());
        contract.create_commitment(
            "reusable".to_string(),
            account("third-vendor.near"),
            U128(100),
            "Third obligation".to_string(),
        );

        let commitments = contract.get_commitments(None, None).commitments;
        assert_eq!(commitments.len(), 1);
        assert_eq!(commitments[0].id, "reusable");
        assert_eq!(commitments[0].recipient_id, account("third-vendor.near"));
        assert_eq!(commitments[0].amount.0, 100);
        assert!(!commitments[0].settlement_pending);
        assert_eq!(contract.get_financial_position().active_commitments.0, 100);
    }

    #[test]
    fn commitments_are_returned_in_bounded_cursor_pages() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 10_000;
        for id in ["a", "b", "c", "d", "e"] {
            contract.create_commitment(
                id.to_string(),
                account("vendor.near"),
                U128(10),
                "Page test".to_string(),
            );
        }

        let first = contract.get_commitments(None, Some(2));
        assert_eq!(first.commitments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(first.next_cursor.as_deref(), Some("b"));

        let second = contract.get_commitments(first.next_cursor, Some(2));
        assert_eq!(second.commitments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["c", "d"]);
        assert_eq!(second.next_cursor.as_deref(), Some("d"));

        let third = contract.get_commitments(second.next_cursor, Some(2));
        assert_eq!(third.commitments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["e"]);
        assert_eq!(third.next_cursor, None);
    }

    #[test]
    fn commitment_page_size_is_capped() {
        let contract = setup("owner.near");
        let page = contract.get_commitments(None, Some(u32::MAX));
        assert!(page.commitments.len() <= MAX_COMMITMENT_PAGE_SIZE as usize);
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    #[should_panic(expected = "Maximum active commitments reached")]
    fn rejects_commitments_beyond_active_limit() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000_000;
        for index in 0..MAX_COMMITMENTS {
            let id = format!("commitment-{index:03}");
            contract.create_commitment(
                id,
                account("vendor.near"),
                U128(1),
                "Bounded commitment".to_string(),
            );
        }
        contract.create_commitment(
            "one-too-many".to_string(),
            account("vendor.near"),
            U128(1),
            "Must be rejected".to_string(),
        );
    }

    #[test]
    fn commitment_total_is_counted_against_treasury() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "contractor".to_string(),
            account("contractor.near"),
            U128(400),
            "Contractor invoice".to_string(),
        );
        contract.create_commitment(
            "supplier".to_string(),
            account("supplier.near"),
            U128(200),
            "Supplier invoice".to_string(),
        );
        let p = contract.get_financial_position();
        assert_eq!(p.active_commitments.0, 600);
        assert_eq!(p.safety_reserve.0, 100);
        assert_eq!(p.spendable_balance.0, 300);
    }

    #[test]
    #[should_panic(expected = "Commitments and reserve exceed treasury balance")]
    fn rejects_commitments_that_overreserve_treasury() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 500;
        contract.create_commitment(
            "too-large".to_string(),
            account("vendor.near"),
            U128(450),
            "Over-reservation".to_string(),
        );
    }

    #[test]
    fn pending_discretionary_payment_is_reserved() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "payroll".to_string(),
            account("worker.near"),
            U128(600),
            "Payroll".to_string(),
        );
        contract.pending.insert(&7, &PendingTransfer {
            id: 7,
            amount: 200,
            kind: PendingKind::Discretionary {
                recipient_id: account("shop.near"),
                memo: None,
            },
            created_at_ns: 1,
        });
        let p = contract.get_financial_position();
        assert_eq!(p.spendable_balance.0, 100);
        assert_eq!(p.pending_discretionary.0, 200);
    }

    #[test]
    fn trusted_token_deposit_increases_treasury_balance() {
        let mut contract = setup("owner.near");
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(account("token.near"));
        testing_env!(builder.build());

        let unused = contract.ft_on_transfer(
            account("depositor.near"),
            U128(250),
            String::new(),
        );
        assert!(matches!(unused, PromiseOrValue::Value(U128(0))));
        assert_eq!(contract.get_financial_position().treasury_balance.0, 250);
    }

    #[test]
    #[should_panic(expected = "Untrusted token contract")]
    fn rejects_deposit_from_untrusted_token_contract() {
        let mut contract = setup("owner.near");
        contract.ft_on_transfer(
            account("attacker.near"),
            U128(250),
            String::new(),
        );
    }

    #[test]
    #[should_panic(expected = "Payment memo is too long")]
    fn rejects_oversized_payment_memo() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(
            account("vendor.near"),
            U128(50),
            Some("m".repeat(MAX_PAYMENT_MEMO_LENGTH + 1)),
        );
    }

    #[test]
    fn accepts_payment_memo_at_maximum_length() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(
            account("vendor.near"),
            U128(50),
            Some("m".repeat(MAX_PAYMENT_MEMO_LENGTH)),
        );
        assert_eq!(contract.get_pending_transfers().len(), 1);
    }

    #[test]
    #[should_panic(expected = "Only the authorized agent")]
    fn rejects_payment_request_from_non_agent() {
        let mut contract = setup("owner.near");
        contract.request_payment(
            account("vendor.near"),
            U128(50),
            None,
        );
    }

    fn callback_context() {
        let mut builder = VMContextBuilder::new();
        builder.current_account_id(account("treasury.near"));
        builder.predecessor_account_id(account("treasury.near"));
        testing_env!(builder.build());
    }



    #[test]
    #[should_panic(expected = "Agent and owner must differ")]
    fn cannot_set_owner_as_agent() {
        let mut contract = setup("owner.near");
        contract.set_agent(account("owner.near"), U128(500));
    }

    #[test]
    #[should_panic(expected = "Agent cannot be treasury contract")]
    fn cannot_set_treasury_as_agent() {
        let mut contract = setup("owner.near");
        let mut builder = VMContextBuilder::new();
        builder.current_account_id(account("treasury.near"));
        builder.predecessor_account_id(account("owner.near"));
        testing_env!(builder.build());
        contract.set_agent(account("treasury.near"), U128(500));
    }

    #[test]
    fn owner_can_rotate_agent_without_changing_role_separation() {
        let mut contract = setup("owner.near");
        contract.set_agent(account("new-agent.near"), U128(300));
        assert_eq!(contract.agent_id, account("new-agent.near"));
        assert_eq!(contract.max_per_transaction, 300);
    }

    #[test]
    #[should_panic(expected = "Per-transaction limit exceeded")]
    fn agent_cannot_exceed_per_transaction_limit() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(account("vendor.near"), U128(501), None);
    }

    #[test]
    #[should_panic(expected = "Insufficient spendable balance")]
    fn agent_cannot_spend_commitments_or_safety_reserve() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "payroll-limit".to_string(),
            account("worker.near"),
            U128(600),
            "Protected payroll".to_string(),
        );

        // Switch to the authorized agent after the owner creates the commitment.
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(account("agent.near"));
        testing_env!(builder.build());

        // 1,000 balance - 600 commitment - 100 reserve = 300 spendable.
        let _ = contract.request_payment(account("vendor.near"), U128(301), None);
    }

    #[test]
    #[should_panic(expected = "Insufficient spendable balance")]
    fn concurrent_pending_payments_cannot_spend_the_same_funds_twice() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;

        // Reserve 500, then another 400. The 100 safety reserve remains protected.
        contract.request_payment(account("vendor-a.near"), U128(500), None);
        contract.request_payment(account("vendor-b.near"), U128(400), None);

        assert_eq!(contract.get_financial_position().pending_discretionary.0, 900);
        assert_eq!(contract.get_financial_position().spendable_balance.0, 0);

        // Even before either callback completes, a third payment must be rejected.
        contract.request_payment(account("vendor-c.near"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "Cannot update a commitment while settlement is pending")]
    fn cannot_update_commitment_during_settlement() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "pending-update".to_string(),
            account("vendor.near"),
            U128(200),
            "Invoice".to_string(),
        );
        contract.settle_commitment("pending-update".to_string());
        contract.update_commitment(
            "pending-update".to_string(),
            account("other-vendor.near"),
            U128(150),
            "Changed invoice".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "Cannot cancel a commitment while settlement is pending")]
    fn cannot_cancel_commitment_during_settlement() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "pending-cancel".to_string(),
            account("vendor.near"),
            U128(200),
            "Invoice".to_string(),
        );
        contract.settle_commitment("pending-cancel".to_string());
        contract.cancel_commitment("pending-cancel".to_string());
    }

    #[test]
    fn successful_discretionary_transfer_reduces_treasury_balance() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(account("vendor.near"), U128(50), None);
        assert_eq!(contract.get_pending_transfers().len(), 1);

        callback_context();
        contract.on_transfer_complete(0, Ok(()));

        assert_eq!(contract.get_financial_position().treasury_balance.0, 950);
        assert_eq!(contract.get_financial_position().pending_discretionary.0, 0);
        assert_eq!(contract.get_financial_position().spendable_balance.0, 850);
        assert!(contract.get_pending_transfers().is_empty());
    }

    #[test]
    fn failed_discretionary_transfer_preserves_treasury_balance() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(account("vendor.near"), U128(50), None);

        callback_context();
        contract.on_transfer_complete(0, Err(PromiseError::Failed));

        assert_eq!(contract.get_financial_position().treasury_balance.0, 1_000);
        assert_eq!(contract.get_financial_position().pending_discretionary.0, 0);
        assert_eq!(contract.get_financial_position().spendable_balance.0, 900);
        assert!(contract.get_pending_transfers().is_empty());
    }



    #[test]
    #[should_panic(expected = "Pending transfer not found")]
    fn rejects_unknown_transfer_callback_id() {
        let mut contract = setup("agent.near");
        callback_context();
        contract.on_transfer_complete(99, Ok(()));
    }

    #[test]
    #[should_panic(expected = "Pending transfer not found")]
    fn rejects_replayed_transfer_callback() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(account("vendor.near"), U128(50), None);

        callback_context();
        contract.on_transfer_complete(0, Ok(()));
        contract.on_transfer_complete(0, Ok(()));
    }

    #[test]
    fn out_of_order_callbacks_preserve_pending_and_treasury_accounting() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(account("vendor-a.near"), U128(100), None);
        contract.request_payment(account("vendor-b.near"), U128(200), None);
        assert_eq!(contract.get_financial_position().pending_discretionary.0, 300);

        callback_context();
        contract.on_transfer_complete(1, Ok(()));
        assert_eq!(contract.get_financial_position().treasury_balance.0, 800);
        assert_eq!(contract.get_financial_position().pending_discretionary.0, 100);
        assert_eq!(contract.get_financial_position().spendable_balance.0, 600);

        contract.on_transfer_complete(0, Ok(()));
        assert_eq!(contract.get_financial_position().treasury_balance.0, 700);
        assert_eq!(contract.get_financial_position().pending_discretionary.0, 0);
        assert_eq!(contract.get_financial_position().spendable_balance.0, 600);
        assert!(contract.get_pending_transfers().is_empty());
    }

    #[test]
    fn mixed_outcome_out_of_order_callbacks_preserve_treasury_accounting() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;

        // Three transfers are pending simultaneously: 100, 200, and 150.
        contract.request_payment(account("vendor-a.near"), U128(100), None);
        contract.request_payment(account("vendor-b.near"), U128(200), None);
        contract.request_payment(account("vendor-c.near"), U128(150), None);

        let initial = contract.get_financial_position();
        assert_eq!(initial.treasury_balance.0, 1_000);
        assert_eq!(initial.pending_discretionary.0, 450);
        assert_eq!(initial.spendable_balance.0, 450);

        callback_context();

        // Transfer B fails first. Its reservation is released without debiting
        // the treasury ledger; transfers A and C remain pending.
        contract.on_transfer_complete(1, Err(PromiseError::Failed));
        let after_failure = contract.get_financial_position();
        assert_eq!(after_failure.treasury_balance.0, 1_000);
        assert_eq!(after_failure.pending_discretionary.0, 250);
        assert_eq!(after_failure.spendable_balance.0, 650);
        assert_eq!(
            contract.get_pending_transfers().iter().map(|p| p.id.0).collect::<Vec<_>>(),
            vec![0, 2],
        );

        // Transfer C succeeds next. Only its 150 is deducted.
        contract.on_transfer_complete(2, Ok(()));
        let after_c_success = contract.get_financial_position();
        assert_eq!(after_c_success.treasury_balance.0, 850);
        assert_eq!(after_c_success.pending_discretionary.0, 100);
        assert_eq!(after_c_success.spendable_balance.0, 650);
        assert_eq!(
            contract.get_pending_transfers().iter().map(|p| p.id.0).collect::<Vec<_>>(),
            vec![0],
        );

        // Transfer A succeeds last. The final debit is exactly 100 more.
        contract.on_transfer_complete(0, Ok(()));
        let final_position = contract.get_financial_position();
        assert_eq!(final_position.treasury_balance.0, 750);
        assert_eq!(final_position.pending_discretionary.0, 0);
        assert_eq!(final_position.spendable_balance.0, 650);
        assert!(contract.get_pending_transfers().is_empty());
    }

    #[test]
    fn successful_commitment_settlement_reduces_balance_and_removes_commitment() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "invoice-1".to_string(),
            account("vendor.near"),
            U128(200),
            "Vendor invoice".to_string(),
        );
        contract.settle_commitment("invoice-1".to_string());
        assert_eq!(contract.get_commitments(None, None).commitments.len(), 1);
        assert!(contract.get_commitments(None, None).commitments[0].settlement_pending);

        callback_context();
        contract.on_transfer_complete(0, Ok(()));

        assert_eq!(contract.get_financial_position().treasury_balance.0, 800);
        assert!(contract.get_commitments(None, None).commitments.is_empty());
    }

    #[test]
    fn failed_commitment_settlement_keeps_commitment_and_releases_pending_flag() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "invoice-2".to_string(),
            account("vendor.near"),
            U128(200),
            "Vendor invoice".to_string(),
        );
        contract.settle_commitment("invoice-2".to_string());

        callback_context();
        contract.on_transfer_complete(0, Err(PromiseError::Failed));

        let commitments = contract.get_commitments(None, None).commitments;
        assert_eq!(commitments.len(), 1);
        assert!(!commitments[0].settlement_pending);
        assert_eq!(commitments[0].amount.0, 200);
        assert_eq!(contract.get_financial_position().treasury_balance.0, 1_000);
    }

    #[test]
    fn failed_commitment_settlement_can_be_retried_successfully() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "retry-invoice".to_string(),
            account("vendor.near"),
            U128(200),
            "Retryable vendor invoice".to_string(),
        );

        // First attempt fails: the obligation must remain active and retryable.
        contract.settle_commitment("retry-invoice".to_string());
        callback_context();
        contract.on_transfer_complete(0, Err(PromiseError::Failed));

        let after_failure = contract.get_financial_position();
        assert_eq!(after_failure.treasury_balance.0, 1_000);
        assert_eq!(after_failure.active_commitments.0, 200);
        assert_eq!(after_failure.spendable_balance.0, 700);
        assert!(contract.get_pending_transfers().is_empty());

        let failed_commitment = contract.get_commitments(None, None).commitments;
        assert_eq!(failed_commitment.len(), 1);
        assert_eq!(failed_commitment[0].id, "retry-invoice");
        assert_eq!(failed_commitment[0].recipient_id, account("vendor.near"));
        assert_eq!(failed_commitment[0].amount.0, 200);
        assert!(!failed_commitment[0].settlement_pending);

        // The owner can retry the same obligation after the failure callback.
        let mut owner_context = VMContextBuilder::new();
        owner_context.predecessor_account_id(account("owner.near"));
        testing_env!(owner_context.build());
        contract.settle_commitment("retry-invoice".to_string());

        let retry_pending = contract.get_pending_transfers();
        assert_eq!(retry_pending.len(), 1);
        assert_eq!(retry_pending[0].id.0, 1);
        assert_eq!(retry_pending[0].amount.0, 200);

        callback_context();
        contract.on_transfer_complete(1, Ok(()));

        let final_position = contract.get_financial_position();
        assert_eq!(final_position.treasury_balance.0, 800);
        assert_eq!(final_position.active_commitments.0, 0);
        assert_eq!(final_position.spendable_balance.0, 700);
        assert!(contract.get_commitments(None, None).commitments.is_empty());
        assert!(contract.get_pending_transfers().is_empty());
    }

    #[test]
    fn owner_can_cancel_commitment_and_release_reservation() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "vendor".to_string(),
            account("vendor.near"),
            U128(400),
            "Vendor".to_string(),
        );
        contract.cancel_commitment("vendor".to_string());
        assert_eq!(contract.get_financial_position().spendable_balance.0, 900);
    }

    #[test]
    #[should_panic(expected = "Token balance audit in progress")]
    fn rejects_deposit_while_balance_audit_is_pending() {
        let mut contract = setup("token.near");
        contract.balance_audit_pending = true;
        contract.ft_on_transfer(
            account("depositor.near"),
            U128(10),
            String::new(),
        );
    }

    #[test]
    #[should_panic(expected = "Token balance audit in progress")]
    fn rejects_outgoing_transfer_while_balance_audit_is_pending() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.balance_audit_pending = true;
        contract.request_payment(account("vendor.near"), U128(10), None);
    }

    #[test]
    #[should_panic(expected = "Cannot audit while transfers are pending")]
    fn rejects_balance_audit_while_outgoing_transfer_is_pending() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(account("vendor.near"), U128(10), None);

        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(account("owner.near"));
        testing_env!(builder.build());
        contract.refresh_token_balance_audit();
    }


    #[test]
    #[should_panic(expected = "Reconciliation amount must be positive")]
    fn rejects_zero_surplus_reconciliation() {
        let mut contract = setup("owner.near");
        contract.observed_token_balance = Some(250);
        contract.ledger_balance_at_observation = Some(0);
        contract.reconcile_token_surplus(U128(0));
    }

    #[test]
    #[should_panic(expected = "Amount exceeds observed token surplus")]
    fn rejects_reconciliation_above_observed_surplus() {
        let mut contract = setup("owner.near");
        contract.observed_token_balance = Some(250);
        contract.ledger_balance_at_observation = Some(0);
        contract.reconcile_token_surplus(U128(251));
    }

    #[test]
    #[should_panic(expected = "A successful balance audit is required")]
    fn rejects_reconciliation_without_successful_audit() {
        let mut contract = setup("owner.near");
        contract.reconcile_token_surplus(U128(1));
    }

    #[test]
    #[should_panic(expected = "No token surplus was observed")]
    fn rejects_reconciliation_when_observed_balance_matches_ledger() {
        let mut contract = setup("owner.near");
        contract.observed_token_balance = Some(100);
        contract.ledger_balance_at_observation = Some(100);
        contract.treasury_balance = 100;
        contract.reconcile_token_surplus(U128(1));
    }

    #[test]
    #[should_panic(expected = "Only the treasury owner")]
    fn rejects_surplus_reconciliation_by_non_owner() {
        let mut contract = setup("agent.near");
        contract.observed_token_balance = Some(250);
        contract.ledger_balance_at_observation = Some(0);
        contract.reconcile_token_surplus(U128(1));
    }

    #[test]
    fn outgoing_transfer_invalidates_previous_balance_audit() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.observed_token_balance = Some(1_000);
        contract.ledger_balance_at_observation = Some(1_000);
        contract.balance_observed_at_ns = Some(123);
        contract.request_payment(account("vendor.near"), U128(100), None);
        assert_eq!(contract.observed_token_balance, None);
        assert_eq!(contract.ledger_balance_at_observation, None);
        assert_eq!(contract.balance_observed_at_ns, None);
    }


    #[test]
    #[should_panic(expected = "Treasury is paused")]
    fn paused_treasury_rejects_new_agent_payment() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.paused = true;
        contract.request_payment(account("vendor.near"), U128(50), None);
    }

    #[test]
    #[should_panic(expected = "Treasury is paused")]
    fn paused_treasury_rejects_new_commitment_settlement() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "paused-invoice".to_string(),
            account("vendor.near"),
            U128(100),
            "Invoice".to_string(),
        );
        contract.paused = true;
        contract.settle_commitment("paused-invoice".to_string());
    }

    #[test]
    fn owner_can_pause_and_unpause_treasury() {
        let mut contract = setup("owner.near");
        contract.set_paused(true);
        assert!(contract.get_pause_status());
        contract.set_paused(false);
        assert!(!contract.get_pause_status());
    }

    #[test]
    #[should_panic(expected = "Only the treasury owner")]
    fn non_owner_cannot_pause_treasury() {
        let mut contract = setup("agent.near");
        contract.set_paused(true);
    }

    #[test]
    fn pending_transfer_callback_completes_while_paused() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        contract.request_payment(account("vendor.near"), U128(100), None);

        let mut owner_context = VMContextBuilder::new();
        owner_context.current_account_id(account("treasury.near"));
        owner_context.predecessor_account_id(account("owner.near"));
        testing_env!(owner_context.build());
        contract.set_paused(true);

        callback_context();
        contract.on_transfer_complete(0, Ok(()));

        assert_eq!(contract.treasury_balance, 900);
        assert!(contract.pending.is_empty());
        assert!(contract.get_pause_status());
    }

    #[test]
    fn accepted_deposit_is_still_credited_while_paused() {
        let mut contract = setup("owner.near");
        contract.paused = true;
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(account("token.near"));
        testing_env!(builder.build());

        contract.ft_on_transfer(account("depositor.near"), U128(100), String::new());
        assert_eq!(contract.treasury_balance, 100);
        assert!(contract.paused);
    }


    #[test]
    fn pending_transfer_records_creation_timestamp() {
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(account("agent.near"));
        builder.block_timestamp(123_456);
        testing_env!(builder.build());
        let mut contract = Veltron::new(
            account("owner.near"),
            account("token.near"),
            account("agent.near"),
            U128(500),
            U128(100),
        );
        contract.treasury_balance = 1_000;
        contract.request_payment(account("vendor.near"), U128(100), None);
        let pending = contract.get_pending_transfers();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].created_at_ns, U64(123_456));
        assert_eq!(pending[0].amount, U128(100));
    }

    #[test]
    #[should_panic(expected = "Maximum pending transfers reached")]
    fn rejects_new_transfer_when_pending_limit_is_reached() {
        let mut contract = setup("agent.near");
        contract.treasury_balance = 1_000;
        for id in 0..MAX_PENDING_TRANSFERS as u64 {
            contract.pending.insert(&id, &PendingTransfer {
                id,
                amount: 1,
                kind: PendingKind::Discretionary {
                    recipient_id: account("vendor.near"),
                    memo: None,
                },
                created_at_ns: 1,
            });
        }
        contract.request_payment(account("vendor.near"), U128(1), None);
    }


    #[test]
    fn discretionary_payment_during_pending_commitment_settlement_preserves_reservations() {
        let mut contract = setup("owner.near");
        contract.treasury_balance = 1_000;
        contract.create_commitment(
            "payroll".to_string(),
            account("worker.near"),
            U128(400),
            "Protected payroll".to_string(),
        );

        // Settlement is asynchronous: the commitment remains reserved until success.
        contract.settle_commitment("payroll".to_string());
        assert_eq!(contract.get_financial_position().active_commitments.0, 400);
        assert_eq!(contract.get_financial_position().spendable_balance.0, 500);

        // The agent may spend only the remaining 500, not the amount being settled.
        let mut agent_context = VMContextBuilder::new();
        agent_context.predecessor_account_id(account("agent.near"));
        testing_env!(agent_context.build());
        contract.request_payment(account("vendor.near"), U128(500), None);

        let during_both_pending = contract.get_financial_position();
        assert_eq!(during_both_pending.pending_discretionary.0, 500);
        assert_eq!(during_both_pending.active_commitments.0, 400);
        assert_eq!(during_both_pending.spendable_balance.0, 0);

        // Complete the discretionary transfer first, while the commitment settlement
        // is still pending. The commitment must remain fully reserved.
        callback_context();
        contract.on_transfer_complete(1, Ok(()));
        let after_discretionary = contract.get_financial_position();
        assert_eq!(after_discretionary.treasury_balance.0, 500);
        assert_eq!(after_discretionary.active_commitments.0, 400);
        assert_eq!(after_discretionary.spendable_balance.0, 0);

        // Then complete the commitment settlement. The final ledger must remain solvent.
        contract.on_transfer_complete(0, Ok(()));
        let final_position = contract.get_financial_position();
        assert_eq!(final_position.treasury_balance.0, 100);
        assert_eq!(final_position.active_commitments.0, 0);
        assert_eq!(final_position.pending_discretionary.0, 0);
        assert_eq!(final_position.spendable_balance.0, 0);
        assert!(contract.get_commitments(None, None).commitments.is_empty());
        assert!(contract.get_pending_transfers().is_empty());
    }

}
