# Usability Report — AN-P1B-LEDGER-GUARANTEES-1

## 1. UI Visibility & Product Language Compliance (UI_VISIBILITY_RULE)

The general journal interface has been made directly accessible within the Accounting Core area:
- **Location**: Screen «المحاسبة» (Accounting Core) -> Tab «دفتر اليومية العامة (Journal Entries)».
- **Terminology**: Pure Arabic domain terminology used throughout:
  - «رقم القيد» (Entry Number)
  - «تاريخ القيد» (Entry Date)
  - «البيان / الشرح» (Memo / Description)
  - «مرحّل» (Posted status badge with green indicator)
  - «مسودة» (Draft status badge with amber indicator)
  - «مدين» (Debit)
  - «دائن» (Credit)
  - «القيد متوازن» (Balanced entry live validation)
  - «ترحيل القيد» (Post Entry action button)
  - «عكس القيد» (Reverse Entry action button)
- **Zero Jargon**: Completely free of developer terms, raw database names, or infrastructure internals.

## 2. Guardrails & User Guidance
1. **Live Balance Feedback**: While composing draft entries, the modal displays live running totals of Debit and Credit. If amounts differ, an amber alert clearly states the difference.
2. **Single-Sided Entry Enforcement**: Entering an amount in the Debit column automatically clears Credit for that line and vice-versa, preventing common data entry errors.
3. **Role Gates**: Users with `company_user` role can view journal entries and details in read-only mode; only users with `ACCOUNTING_JOURNALS_POST` (`platform_admin` and `company_admin`) see the active Post and Reverse action buttons.
