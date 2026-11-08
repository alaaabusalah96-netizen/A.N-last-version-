# Usability Report — AN-P1C-ORG-UNITS-1

## 1. UI Visibility & Product Language Compliance (UI_VISIBILITY_RULE)

The organizational units interface has been added as a first-class screen in the platform shell:
- **Navigation**: Sidebar -> «الوحدات التنظيمية» (with `Network` icon).
- **Terminology**: Pure Arabic domain terminology used:
  - «كود الوحدة» (Unit Code, e.g. `BR-CAI-01`)
  - «اسم الوحدة» (Unit Name in Arabic and English)
  - «النوع التنظيمي» (Categorized as: فرع تشغيلي / إداري أو قسم / مركز تكلفة / قطاع أعمال)
  - «المسار الهيكلي» (Hierarchical Path, e.g. `/HQ/NORTH/CAI/`)
  - «الحالة» (Active / Inactive status badges)
  - «إضافة وحدة تنظيمية» (Create Unit modal with parent tree selector)
  - «تفعيل» / «تعطيل» (Status toggle actions)
- **Hierarchy Visualization**: Table visually indents nested units based on hierarchical path depth with tree branch indicators.

## 2. Role Gates & Guardrails
1. **Intercompany Prevention**: The parent unit selector restricts choices strictly to active units belonging to the currently selected company.
2. **Access Control**: Users with `company_user` view units in read-only mode, while `company_admin` and `platform_admin` can create and toggle unit statuses.
