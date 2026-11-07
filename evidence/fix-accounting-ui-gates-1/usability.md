# Usability & UI Gating Assessment — AN-FIX-ACCOUNTING-UI-GATES-1

- **UI Alignment**: Chart of Accounts action buttons ("حساب جديد" and "تحميل الدليل الافتراضي") are now dynamically gated in `AccountsPanel` based on user administrative capabilities (`canCreate` / `canSeed`), preventing read-only roles (`company_user`) from seeing write affordances while retaining full read access.
- **Fail-Closed Principle**: If capability props are omitted, defaults are strictly fail-closed (`false`).
