import { useState } from 'react';
import { useTaskStore } from '../stores/taskStore';

// Manage ICS calendar subscriptions (read-only feeds; works on every platform)
export function IcsSubscriptionSettings() {
  const { icsSubscriptions, addIcsSubscription, removeIcsSubscription } = useTaskStore();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const handleAdd = async () => {
    if (!name.trim() || !url.trim()) return;
    setIsAdding(true);
    setError(null);
    try {
      await addIcsSubscription(name, url);
      setName('');
      setUrl('');
    } catch (e) {
      setError(String(e));
    } finally {
      setIsAdding(false);
    }
  };

  const inputClass =
    'w-full px-2.5 py-1.5 text-[12px] rounded-lg bg-[#F5F5F5] dark:bg-[#2E2E2E] text-[#1A1A1A] dark:text-[#E0E0E0] placeholder-[#B0B0B0] dark:placeholder-[#555] outline-none focus:ring-1.5 focus:ring-primary/40';

  return (
    <div className="space-y-2 mt-4">
      <div className="flex items-center justify-between text-[11px] text-[#B0B0B0] dark:text-[#555]">
        <span>Subscriptions (ICS)</span>
      </div>
      <p className="text-[11px] text-[#B0B0B0] dark:text-[#555] leading-relaxed">
        Subscribe to calendar feeds by URL — Google Calendar "secret address", Outlook published
        calendars, or any .ics link. Feeds are read-only and refresh every few minutes.
      </p>

      {icsSubscriptions.map((sub) => (
        <div
          key={sub.id}
          className="flex items-center gap-2 py-1.5 px-1.5 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] rounded-lg group"
        >
          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: sub.color }} />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-[#1A1A1A] dark:text-[#E0E0E0] truncate">{sub.name}</div>
            <div className="text-[11px] text-[#B0B0B0] dark:text-[#555] truncate">{sub.url}</div>
          </div>
          <button
            onClick={() => removeIcsSubscription(sub.id).catch((e) => setError(String(e)))}
            title="Remove subscription"
            className="text-[#B0B0B0] hover:text-danger opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity px-1"
          >
            ✕
          </button>
        </div>
      ))}

      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className={`${inputClass} max-w-[120px]`}
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="https://… or webcal://…"
          className={inputClass}
        />
        <button
          onClick={handleAdd}
          disabled={isAdding || !name.trim() || !url.trim()}
          className="text-[12px] font-medium text-primary hover:text-primary-dark disabled:opacity-40 px-1.5 transition-colors flex-shrink-0"
        >
          Add
        </button>
      </div>

      {error && (
        <div className="text-[12px] text-danger bg-danger/8 px-3 py-2 rounded-lg">{error}</div>
      )}
    </div>
  );
}
