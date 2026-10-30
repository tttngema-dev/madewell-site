// Free phone alerts through ntfy.sh. Keep messages free of personal details.
export async function push(title, message) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', headers: { Title: title, Tags: 'bell' }, body: message });
  } catch (e) { console.error('ntfy failed:', e.message); }
}
