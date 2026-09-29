"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const SESSION_STORAGE_KEY = "retail-store-manager.hermes-chat-session";
const MAX_MESSAGE_LENGTH = 4_000;
const STARTER_PROMPTS = [
  "Give me the morning briefing",
  "What are my top priorities right now?",
  "What's the OPD status?",
  "How are checkout operations performing?",
] as const;

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ChatStep = {
  id: string;
  label: string;
  state: "running" | "completed" | "failed";
};

type ChatStatus = "checking" | "ready" | "disabled" | "unavailable";

type StreamEvent = {
  type?: string;
  session_id?: string;
  content?: string;
  tool_name?: string;
};

type RequestedPrompt = { id: string; text: string };

type HermesChatProps = {
  requestedPrompt?: RequestedPrompt | null;
  onRequestedPromptConsumed?: (id: string) => void;
};

function toolLabel(name: string) {
  const known: Record<string, string> = {
    skill_view: "Reading skill",
    terminal: "Running task",
    vision_analyze: "Analyzing image",
    viking_search: "Searching memory",
  };
  return known[name] || name.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function readSseBlock(block: string): StreamEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}

function ChatSteps({ steps }: { steps: ChatStep[] }) {
  return (
    <ul className="chat-steps" aria-label="Hermes activity">
      {steps.map((step) => (
        <li className={`chat-step chat-step--${step.state}`} key={step.id}>
          <i aria-hidden="true" />{step.label}
        </li>
      ))}
    </ul>
  );
}

function RichMessage({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: label, href }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">{label}</a>
        ),
        img: ({ alt }) => <span className="chat-image-reference">Image: {alt || "attachment"}</span>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export default function HermesChat({
  requestedPrompt = null,
  onRequestedPromptConsumed,
}: HermesChatProps) {
  const [status, setStatus] = useState<ChatStatus>("checking");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [steps, setSteps] = useState<ChatStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const consumedPromptRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const storedSession = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    const query = storedSession ? `?session_id=${encodeURIComponent(storedSession)}` : "";

    void fetch(`/api/hermes-chat${query}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json() as {
          enabled?: boolean;
          connected?: boolean;
          session_id?: string;
          messages?: ChatMessage[];
        };
        if (!payload.enabled) {
          setStatus("disabled");
          return;
        }
        if (!response.ok || !payload.connected) throw new Error("unavailable");
        setStatus("ready");
        if (payload.session_id) {
          setSessionId(payload.session_id);
          setMessages(payload.messages || []);
        } else if (storedSession) {
          window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
        }
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setStatus("unavailable");
        }
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, draft, steps]);

  function newConversation() {
    if (running) return;
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    setSessionId(null);
    setMessages([]);
    setDraft("");
    setSteps([]);
    setError(null);
  }

  const submitMessage = useCallback(async (value: string) => {
    const message = value.trim();
    if (!message || running || status !== "ready") return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: message,
    };
    setMessages((current) => [...current, userMessage]);
    setInput("");
    setRunning(true);
    setDraft("");
    setSteps([]);
    setError(null);

    try {
      const response = await fetch("/api/hermes-chat", {
        method: "POST",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, input: message }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message || "Hermes could not start this turn.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalContent = "";

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
          const item = readSseBlock(block);
          if (!item?.type) continue;
          if (item.session_id) {
            setSessionId(item.session_id);
            window.sessionStorage.setItem(SESSION_STORAGE_KEY, item.session_id);
          }
          if (item.type === "assistant.delta" && item.content) {
            setDraft((current) => current + item.content);
          } else if (item.type === "assistant.completed") {
            finalContent = item.content || "";
            setDraft(finalContent);
          } else if (item.type === "tool.started" && item.tool_name) {
            const toolName = item.tool_name;
            setSteps((current) => [
              ...current.filter((step) => step.id !== toolName),
              { id: toolName, label: toolLabel(toolName), state: "running" },
            ]);
          } else if ((item.type === "tool.completed" || item.type === "tool.failed") && item.tool_name) {
            const toolName = item.tool_name;
            setSteps((current) => current.map((step) => step.id === toolName
              ? { ...step, state: item.type === "tool.completed" ? "completed" : "failed" }
              : step));
          } else if (item.type === "error") {
            throw new Error(item.content || "Hermes could not complete this turn.");
          }
        }
        if (done) break;
      }

      if (finalContent) {
        setMessages((current) => [...current, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: finalContent,
        }]);
      } else {
        throw new Error("Hermes completed without a final response.");
      }
      setDraft("");
    } catch (reason) {
      setDraft("");
      setError(reason instanceof Error ? reason.message : "Hermes could not complete this turn.");
    } finally {
      setRunning(false);
    }
  }, [running, sessionId, status]);

  useEffect(() => {
    if (
      !requestedPrompt
      || status === "checking"
      || running
      || consumedPromptRef.current === requestedPrompt.id
    ) return;
    const frame = window.requestAnimationFrame(() => {
      consumedPromptRef.current = requestedPrompt.id;
      onRequestedPromptConsumed?.(requestedPrompt.id);
      if (status === "ready") void submitMessage(requestedPrompt.text);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [onRequestedPromptConsumed, requestedPrompt, running, status, submitMessage]);

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    void submitMessage(input);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage(input);
    }
  }

  return (
    <section className="hermes-chat" aria-labelledby="hermes-chat-title">
      <header className="platform-header hermes-chat__header">
        <div>
          <span className="platform-eyebrow">Store Manager</span>
          <h2 id="hermes-chat-title">Chat with Hermes</h2>
        </div>
        <button
          type="button"
          className="telemetry-view-button"
          disabled={running || messages.length === 0}
          onClick={newConversation}
        >
          <span aria-hidden="true">＋</span>New chat
        </button>
      </header>

      <div className="dashboard-panel hermes-chat__body" ref={scrollRef} aria-live="polite">
        {status === "checking" ? (
          <div className="chat-empty"><strong>Connecting to Hermes</strong></div>
        ) : status === "disabled" ? (
          <div className="chat-empty">
            <strong>Chat is not enabled for this UI.</strong>
            <span>Rerun <code>./install.sh</code> with <code>STORE_MANAGER_ENABLE_CHAT=1</code>.</span>
          </div>
        ) : status === "unavailable" ? (
          <div className="chat-empty chat-empty--error">
            <strong>Hermes chat is unavailable.</strong>
            <span>Verify the Hermes API server, then rerun <code>./install.sh</code>.</span>
          </div>
        ) : messages.length === 0 && !running ? (
          <div className="chat-empty">
            <span className="chat-empty__mark" aria-hidden="true">✦</span>
            <strong>Ask Hermes about your store.</strong>
            <div className="chat-starters" aria-label="Example prompts">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  type="button"
                  key={prompt}
                  onClick={() => void submitMessage(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="chat-thread">
          {messages.map((message) => (
            <article className={`chat-message chat-message--${message.role}`} key={message.id}>
              <span>{message.role === "user" ? "You" : "Hermes"}</span>
              {message.role === "assistant" ? (
                <div className="chat-markdown">
                  <RichMessage>{message.content}</RichMessage>
                </div>
              ) : <p>{message.content}</p>}
            </article>
          ))}

          {!running && steps.length ? <ChatSteps steps={steps} /> : null}

          {running ? (
            <article className="chat-message chat-message--assistant chat-message--streaming">
              <span>Hermes</span>
              {steps.length ? <ChatSteps steps={steps} /> : <div className="chat-thinking"><i aria-hidden="true" />Working</div>}
              {draft ? (
                <div className="chat-markdown">
                  <RichMessage>{draft}</RichMessage>
                </div>
              ) : null}
            </article>
          ) : null}

          {error ? <div className="chat-error" role="alert">{error}</div> : null}
        </div>
      </div>

      <form className="chat-composer" onSubmit={sendMessage}>
        <label className="sr-only" htmlFor="hermes-chat-input">Message Hermes</label>
        <textarea
          id="hermes-chat-input"
          value={input}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={2}
          placeholder="Message Hermes"
          disabled={status !== "ready" || running}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleComposerKeyDown}
        />
        <button type="submit" disabled={status !== "ready" || running || !input.trim()} aria-label="Send message">
          <span aria-hidden="true">↑</span>
        </button>
      </form>
    </section>
  );
}
