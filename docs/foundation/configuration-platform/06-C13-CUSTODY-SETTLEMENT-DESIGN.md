# C13 - Custody Shortage Treatments: Design (draft, no code)

Status: DRAFT for owner decision. No accounting code is written until the open questions below are answered.
Builds on: R08-P2a/P2a-2 (shortage claim and repayment), roadmap package C13, principles in README.md (configurable, cite a standard).

## 1. What exists today
- A cash count is a record only. It never posts.
- A shortage claim is created from a count with negative variance. It posts nothing. It states that the employee owes the amount.
- Repayment by the employee in cash: Dr register cash / Cr custody receivable. Outstanding is derived from append-only repayments.
- Only this one treatment ("employee repays") is built. It is the default and stays the default.

## 2. Treatments to support (each is a choice, not a hardcoded rule)
| Code | Treatment | Journal entry when it settles the claim | Basis |
|---|---|---|---|
| EMPLOYEE_REPAY | Employee pays cash back | Dr register cash / Cr custody receivable | Built. Standard petty cash practice: shortage recovered from the custodian. |
| PAYROLL_DEDUCT | Recover from salary | Dr employee payroll receivable (or payroll payable, per mapping) / Cr custody receivable | Needs the company's payroll policy and local labour-law limits on deductions. Cash is not touched. |
| WRITE_OFF | Company absorbs the loss after approval | Dr cash short and over (or loss) expense account / Cr custody receivable | Standard "cash short and over" treatment. Allowed only when the company enables it and an approver signs. |
| PARTIAL_MIX | Any combination of the above on one claim | One entry per settlement line | A claim can be settled in several steps. Sum of settlements can never exceed outstanding. |

Every treatment reduces the same outstanding amount. History is append-only: a settlement is never edited, a wrong one is reversed by a new entry.

## 3. Configuration (per company, no code)
- `allowed_treatments`: the set of treatments the company enables. Default: EMPLOYEE_REPAY only.
- Account mapping per treatment (uses B5 account mapping): custody receivable, cash short and over / loss expense, payroll receivable. A treatment with no mapped account cannot be enabled.
- Approval path per treatment: a list of steps, each is a permission or role. Default: EMPLOYEE_REPAY needs `custody:settle` only (as today); WRITE_OFF and PAYROLL_DEDUCT need a request step plus a separate approve step.
- Optional limits: write-off ceiling per claim and a higher ceiling that needs a second approver.
- Until the workflow engine (C1) exists, an approval path is a single permission gate plus the rule that the approver differs from the requester.

## 4. Data model sketch
- `custody_settlement_policies` (company_id, treatment, enabled, ceiling, account mappings, approval steps as JSON validated against a schema).
- `custody_shortage_settlements` (claim_id, treatment, amount, status requested/approved/rejected/posted/reversed, requested_by, approved_by, journal_entry_id, reason). Append-only with triggers, like repayments. Existing repayments map to EMPLOYEE_REPAY rows so history stays consistent.
- RLS and `table_ownership.json` entries as for every tenant table.

## 5. Rules the tests must prove
1. A treatment that is not enabled is rejected by the server.
2. Each treatment posts exactly the expected entry, balanced, in an open period.
3. Requester cannot approve their own request.
4. Total settlements never exceed the claim; concurrent settlements cannot overshoot.
5. Every request, approval, rejection and reversal is audited.
6. The count itself never posts (existing rule stays).
7. Default company behaves exactly as P2a-2 today (no regression).

## 6. Open questions for the owner (need a decision, not an assumption)
1. Which treatments should be available at start: employee repay only, plus write-off, plus payroll deduction?
2. Who approves a write-off (role or permission), and is there a ceiling above which a second approver is needed?
3. Payroll deduction: is it only recorded as a receivable until payroll processes it, or must the ERP produce a deduction record for payroll? (Payroll integration itself is out of scope.)
4. Which account is used for cash short and over, and does it differ per company?
Alaa is not an accountant: where he does not specify, the default is the standard practice in section 2, enabled only when he turns it on.

## 7. Sequencing
C13-a: policy tables, mapping validation, settlement table, migration of existing repayments. C13-b: write-off with approval. C13-c: payroll deduction record. C13-d: settings UI. One package at a time, each verified before the next.
