# حالة عزل المستأجرين (Tenant Isolation Status)

## 1. التقييم الفني المحدث
- **الحالة الحالية**: `IMPLEMENTED` + `INTEGRATION_TESTED` (RLS policies + `withTenantTransaction`).
- **الجاهزية للإنتاج**: `PRODUCTION_READY` مع وجود قاعدة بيانات PostgreSQL مدعومة بـ RLS.

## 2. جدول تصنيف الجداول (Table Classification)
| Table | Class | Isolation Mechanism |
|-------|-------|---------------------|
| `platform_users` | global | Global identity catalog (Authentication core) |
| `user_sessions` | global | User-scoped token hashes (Session security) |
| `companies` | global | Platform tenant catalog (Application-level tenant resolution) |
| `company_memberships` | company-owned | Application-level tenant filtering & relational checks |
| `tenant_demo_items` | company-owned | **PostgreSQL Row-Level Security (RLS)** via `app.current_tenant_id` |

## 3. آلية العزل المنفذة
- **`withTenantTransaction`**: يضمن تعيين سياق المعاملة محليًا عبر `set_config('app.current_tenant_id', id, true)` دون تسريب للجلسات العامة.
- **Fail-Closed**: رفض معرفات الشركات الفارغة أو المزيفة.
