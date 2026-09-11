// Studio assistant chat widget. Talks to a small Vercel-hosted proxy
// (pigments-lab-chat) that holds the actual model credentials server-side —
// this file never sees or sends any API key, just chat messages.

const CHAT_API = "https://pigments-lab-chat.vercel.app/api/chat";

const history = [];

function appendMessage(role, text) {
  const log = document.getElementById("chat-log");
  const bubble = document.createElement("div");
  bubble.className = `chat-msg chat-msg-${role}`;
  bubble.textContent = text;
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

async function sendMessage(evt) {
  evt.preventDefault();
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  input.disabled = true;
  appendMessage("user", text);
  history.push({ role: "user", content: text });

  const assistantBubble = appendMessage("assistant", "…");
  assistantBubble.classList.add("pending");

  try {
    const res = await fetch(CHAT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${res.status} ${detail}`.trim());
    }

    assistantBubble.classList.remove("pending");
    assistantBubble.textContent = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      assistantBubble.textContent = full;
      document.getElementById("chat-log").scrollTop = 1e9;
    }
    history.push({ role: "assistant", content: full });
  } catch (e) {
    assistantBubble.classList.remove("pending");
    assistantBubble.classList.add("chat-msg-error");
    assistantBubble.textContent = `Couldn't reach the assistant (${e.message}). Try again in a moment.`;
  } finally {
    input.disabled = false;
    input.focus();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("chat-form");
  if (form) form.addEventListener("submit", sendMessage);
});
