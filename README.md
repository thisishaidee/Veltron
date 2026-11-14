# VELTRON

**Commitment-aware treasury infrastructure for autonomous businesses, built on [NEAR Protocol](https://near.org/).**

VELTRON prevents autonomous agents from spending treasury funds that have already been allocated to real business obligations.

An agent may have permission to make payments, but that does not make every unit in the treasury available to spend.

> The agent had permission to spend the money. It just wasn't supposed to spend that money.

## The problem

Autonomous businesses need agents that can pay contractors, suppliers, and service providers. A general spending limit is not enough: an agent can stay below its limit and still spend money already promised to someone else.

VELTRON addresses this with an on-chain **Commitment Lock**. The owner records obligations and fixed recipients; the contract reserves those amounts and calculates what remains available for discretionary agent payments.

```
Spendable balance =
  Treasury token balance
  - Active commitments
  - Safety reserve
  - Pending discretionary reservations
```

The contract enforces these accounting rules. The agent and frontend cannot override protected commitments.

## Current system

VELTRON is an early-stage NEAR Testnet MVP composed of:

- **Treasury contract** — Rust / near-sdk contract for a configured NEP-141 token, owner-managed commitments, a safety reserve, an authorized agent, discretionary payment requests, owner-controlled commitment settlement, asynchronous transfer callbacks, and reservations for in-flight payments.
- **Test token** — a separate NEP-141 test-token contract for controlled Testnet exercises.
- **Read-only treasury dashboard** — mobile-first views of financial position, pause state, commitments, pending transfers, token-balance audit, and indexed audit coverage. It does not request wallet signatures or submit transactions.
- **Audit indexer and API** — a Cloudflare Worker with a D1 database. It scans finalized NEAR Testnet blocks, validates block continuity, and stores structured treasury `EVENT_JSON:` receipt logs. Read API: [VELTRON audit events](https://veltron-audit-indexer.haideecoded-e0f.workers.dev/v1/events).
- **Deployment and operator tooling** — guarded GitHub Actions workflows and supporting dashboard/deployer applications.

The current deployment is Testnet-only. The audit indexer is configured to begin structured event coverage at block `277520554`, the finalized block containing the successful event-emitting treasury code upgrade. Its cursor and configured boundary have been aligned. **End-to-end event ingestion still requires a controlled, observed treasury operation that emits a structured event; an empty event table is not evidence that such an operation has been indexed.**

## Example

Imagine the treasury has 1,000 test-token units:

| Allocation | Amount |
|---|---:|
| Treasury balance | 1,000 |
| Contractor commitment | 400 |
| Supplier commitment | 200 |
| Safety reserve | 100 |
| **Available to spend** | **300** |

Even if the agent's per-transaction limit is 500, a request for 450 is rejected because it would consume protected funds. A request for 250 is within the available balance.

These are illustrative test-token units, not a live USDC balance.

## Repository structure

```
.
├── apps/
│   ├── dashboard/       # Read-only treasury and audit monitor
│   ├── deployer/        # Deployment/operator interface
│   └── transfer-preview/
├── contracts/
│   ├── treasury/        # Main Rust treasury contract
│   └── test-token/      # NEP-141 test token
├── docs/                # Contract, deployment, dashboard and audit design
├── services/
│   └── audit-indexer/   # Cloudflare Worker + D1 audit service
├── scripts/
└── .github/workflows/   # CI, deployment and verification workflows
```

## Development and tests

With Rust and the required dependencies installed, run from the repository root:

```bash
cargo test --workspace
```

For the dashboard:

```bash
cd apps/dashboard
npm test
```

For the audit indexer:

```bash
cd services/audit-indexer
npm test
```

GitHub Actions runs the relevant checks for changes to the corresponding components.

## Network, status and safety

- **Network:** NEAR Testnet
- **Primary hackathon track:** Autonomous Business
- **Related track:** AI Security & Defense
- **Security status:** early hackathon MVP; not independently audited and not suitable for production funds.

Testnet deployment and read-only monitoring do not constitute a production security review. Do not deposit real assets or rely on this implementation for live business obligations.

Before production use, VELTRON needs independent contract and integration review, adversarial testing of NEP-141 transfer/callback behavior, verified end-to-end audit ingestion, key-management and incident-response review, and a separately approved mainnet deployment plan. See [the contract design and limitations](docs/CONTRACT-DESIGN.md) and [the Testnet deployment checklist](docs/TESTNET-DEPLOYMENT-CHECKLIST.md).

## Maintainer

Built by [@thisishaidee](https://github.com/thisishaidee).
