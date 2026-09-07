import { useEffect, useRef, useState } from "react";
import { Upload, Trash2 } from "lucide-react";
import { useGithubSettings, useUpdateGithubSettings } from "../../lib/queries";
import { Field } from "../ui/Field";
import type { GithubSettings } from "../../lib/api";
import { canSaveGithubCredentials, isGithubConfigured, saveGithubCredentialsPayload, webhookUrlNow } from "./github-sync-logic";

// Workspace → Settings → GitHub Sync credentials card: GitHub App id,
// webhook secret (write-only), PEM upload, and the webhook URL hint.
export function GithubSyncCredentialsCard({ onRemove }: { onRemove: () => void }) {
  const { data } = useGithubSettings();
  const save = useUpdateGithubSettings();
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const secretTouched = useRef(false);
  const [pemName, setPemName] = useState("");
  const [pemText, setPemText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const synced = useRef(false);

  useEffect(() => {
    if (data && !synced.current) {
      synced.current = true;
      setAppId(data.appId);
    }
  }, [data]);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setPemName(file.name);
      setPemText(String(reader.result ?? ""));
    };
    reader.readAsText(file);
  };

  const configured = isGithubConfigured(data);
  const canSave = canSaveGithubCredentials(appId, pemText);
  const webhookUrl = webhookUrlNow();

  return (
    <>
      <div className="card-panel card-panel--elevated">
        <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Credentials</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="App ID" htmlFor="github-app-id" className="field mb-0">
            <input
              id="github-app-id"
              className="prop-input"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              style={{ width: 110 }}
            />
          </Field>
          <Field label="Webhook secret" htmlFor="github-webhook-secret" className="field mb-0">
            <input
              id="github-webhook-secret"
              className="prop-input font-mono"
              placeholder={data?.webhookSecretSet ? "••••••••••••••••" : "Set once, never displayed"}
              value={secret}
              onChange={(e) => { setSecret(e.target.value); secretTouched.current = true; }}
              style={{ width: 220, fontSize: 12 }}
            />
          </Field>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSave || save.isPending}
            onClick={() => save.mutate(saveGithubCredentialsPayload({ appId, pemText, secret, secretTouched: secretTouched.current }))}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>

        <Field label="Private key" htmlFor="github-pem" hint="Uploaded as a file, never pasted. The PEM is stored server-side; the API only reports whether a key is set." className="field mt-4">
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-ghost" style={{ height: 32, padding: "0 12px", fontSize: 12 }} onClick={() => fileRef.current?.click()}>
              <Upload size={14} strokeWidth={1.5} />
              Choose .pem file
            </button>
            <input
              id="github-pem"
              ref={fileRef}
              type="file"
              accept=".pem,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <span className={`font-mono text-xs ${pemName ? "text-lx-text-secondary" : "text-lx-text-muted"}`}>{pemName || "No file chosen"}</span>
          </div>
        </Field>

        {configured && (
          <div className="mt-4">
            <button type="button" className="btn btn-danger" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={onRemove}>
              <Trash2 size={14} strokeWidth={1.5} />
              Remove GitHub sync
            </button>
          </div>
        )}
      </div>
      <p className="text-xs text-lx-text-muted mt-2">
        Webhook URL: <span className="font-mono">{webhookUrl}</span> — the GitHub App's webhook must deliver here (Content type application/json, secret = webhook secret above).
      </p>
    </>
  );
}
