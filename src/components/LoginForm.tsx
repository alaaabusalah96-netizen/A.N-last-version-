import React, { useState, useEffect } from 'react';
import { Lock, User as UserIcon, LogIn, AlertCircle } from 'lucide-react';
import { apiFetch, refreshCsrfToken } from '../lib/apiClient.js';

interface LoginFormProps {
  onLoginSuccess: (user: { id: string; username: string; role: string }) => void;
}

export function LoginForm({ onLoginSuccess }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [initializingCsrf, setInitializingCsrf] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function initCsrf() {
      try {
        const token = await refreshCsrfToken();
        if (!mounted) return;
        if (!token) {
          setError('تعذر تهيئة رمز الحماية (CSRF). يجدر تحديث الصفحة.');
        }
      } catch {
        if (mounted) {
          setError('فشل الاتصال بخادم الحماية لتهيئة الجلسة');
        }
      } finally {
        if (mounted) {
          setInitializingCsrf(false);
        }
      }
    }
    initCsrf();
    return () => {
      mounted = false;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (initializingCsrf) return;
    setError(null);
    setLoading(true);

    try {
      const trimmedUsername = username.trim().toLowerCase();
      const trimmedPassword = password.trim();
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: trimmedUsername, password: trimmedPassword }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          throw new Error('خدمة قاعدة البيانات أو خادم التطبيق غير متاحين حالياً (503 Service Unavailable)');
        }
        throw new Error(`استجابة غير متوقعة من الخادم (${res.status})`);
      }

      let data: any;
      try {
        data = await res.json();
      } catch {
        throw new Error('تعذر معالجة استجابة الخادم');
      }

      if (!res.ok) {
        throw new Error(data.message || data.error || 'فشل تسجيل الدخول');
      }

      onLoginSuccess(data.user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'خطأ غير متوقع');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md bg-slate-900/90 border border-slate-800 rounded-2xl p-6 md:p-8 shadow-2xl backdrop-blur-md">
      <div className="mb-6 text-center">
        <h2 className="text-xl font-bold text-white mb-1">تسجيل الدخول للمنصة</h2>
        <p className="text-xs text-slate-400">نظام هوية مستقل ذو سيادة محلية (لا Firebase)</p>
      </div>

      {error && (
        <div className="mb-5 p-3.5 bg-red-950/40 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1.5">اسم المستخدم</label>
          <div className="relative">
            <span className="absolute inset-y-0 right-0 flex items-center pr-3.5 pointer-events-none text-slate-500">
              <UserIcon className="w-4 h-4" />
            </span>
            <input
              type="text"
              required
              disabled={initializingCsrf}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              className="w-full pr-10 pl-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition disabled:opacity-50"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1.5">كلمة المرور</label>
          <div className="relative">
            <span className="absolute inset-y-0 right-0 flex items-center pr-3.5 pointer-events-none text-slate-500">
              <Lock className="w-4 h-4" />
            </span>
            <input
              type={showPassword ? 'text' : 'password'}
              required
              disabled={initializingCsrf}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full pr-10 pl-10 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              {showPassword ? (
                <span className="text-xs select-none">إخفاء</span>
              ) : (
                <span className="text-xs select-none">إظهار</span>
              )}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || initializingCsrf}
          className="w-full mt-2 inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 text-white font-medium text-sm transition shadow-lg shadow-indigo-600/25 cursor-pointer"
        >
          {initializingCsrf ? (
            <span className="text-xs text-slate-300">جارٍ تهيئة الجلسة...</span>
          ) : loading ? (
            <span className="inline-block w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></span>
          ) : (
            <>
              <LogIn className="w-4 h-4" />
              <span>دخول</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}
