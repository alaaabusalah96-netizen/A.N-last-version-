# Usability & UX Verification: AN-P1D-ACCOUNTING-UI-EXPANSION-1

## 1. Accounting Workspace Tab Integration
- The Accounting Core workspace navigation bar includes three primary tabs:
  1. «دليل الحسابات (Chart of Accounts)»
  2. «دفتر اليومية العامة (Journal Entries)»
  3. «ميزان المراجعة (Trial Balance)»
- Smooth tab switching without screen flicker or state corruption.

## 2. Trial Balance Controls & Data Display
- **Date Picker**: Allows filtering ledger movements as-of a specific date (`asOfDate`).
- **Org Unit Selector**: Filter balances for a specific branch, department, or cost center, or select "الشركة ككل (الكل)".
- **Summary Cards**: Displays Grand Total Debit, Grand Total Credit, and an automated balance status badge (`ميزان المراجعة متوازن` or `غير متوازن`).
- **Data Table**: Displays Account Code, Account Name (Arabic), Account Type, Debit, Credit, and Net Balance with clear numeric formatting.

## 3. General Ledger Org Unit Integration
- **Draft Creation**: Users can assign an optional active Org Unit when creating a journal entry.
- **Entry List & Detail View**: Displays the assigned Org Unit code and Arabic name on entry rows and modal dialogs.
- **Filtering**: Allows filtering journal entries by Org Unit from the top toolbar.
