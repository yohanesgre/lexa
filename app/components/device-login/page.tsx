import { useState } from "react";
import { useSession, useDeviceLoginRequest, useApproveDeviceLogin, useDenyDeviceLogin } from "../../lib/queries";
import { Shell } from "./shell";
import { PendingVariant } from "./pending";
import { ApprovedVariant } from "./approved";
import { DeniedVariant } from "./denied";
import { ExpiredVariant } from "./expired";
import { NotFoundVariant } from "./not-found";
import { NotSignedInVariant } from "./sign-in";

export type DeviceLoginDoneState = { status: "approved" | "denied" | "expired" | "not-found"; keyName?: string };

const terminalCode = (err: unknown): string => (err as { code?: string })?.code ?? "";

const errorVariant = (err: unknown): React.ReactElement => {
  const code = terminalCode(err);
  if (code === "DEVICE_LOGIN_DENIED") return <DeniedVariant />;
  if (code === "DEVICE_LOGIN_EXPIRED") return <ExpiredVariant />;
  return <NotFoundVariant />;
};

const doneVariant = (done: DeviceLoginDoneState, data: unknown): React.ReactElement | null => {
  if (done.status === "approved") {
    const fromQuery = data && (data as { status: string; keyName?: string }).status === "approved"
      ? (data as { keyName?: string }).keyName
      : "";
    return <ApprovedVariant keyName={done.keyName ?? fromQuery ?? ""} />;
  }
  if (done.status === "denied") return <DeniedVariant />;
  if (done.status === "expired") return <ExpiredVariant />;
  return <NotFoundVariant />;
};

export function DeviceLoginPage({ request, token }: { request?: string | undefined; token?: string | undefined }) {
  const { data: session, isLoading: sessionLoading } = useSession();
  const [done, setDone] = useState<DeviceLoginDoneState | null>(null);
  const [busy, setBusy] = useState<"approving" | "denying" | null>(null);
  const approve = useApproveDeviceLogin();
  const deny = useDenyDeviceLogin();
  const requestQuery = useDeviceLoginRequest(request ?? "", token ?? "");

  // Mutations drive local state (this page owns its outcome); error codes map
  // to the same variants as the initial GET.
  const handleAction = (action: "approve" | "deny") => {
    if (!request || !token || busy !== null) return;
    setBusy(action === "approve" ? "approving" : "denying");
    const mutation = action === "approve" ? approve : deny;
    mutation.mutate(
      { id: request, token },
      {
        onSuccess: (res) => {
          setBusy(null);
          setDone({ status: res.status, keyName: res.clientName });
        },
        onError: (err) => {
          setBusy(null);
          const code = terminalCode(err);
          if (code === "DEVICE_LOGIN_DENIED") setDone({ status: "denied" });
          else if (code === "DEVICE_LOGIN_EXPIRED") setDone({ status: "expired" });
          else setDone({ status: "not-found" });
        },
      }
    );
  };

  if (sessionLoading) return null;
  if (!session?.user) return <Shell><NotSignedInVariant /></Shell>;
  if (!request || !token) return <Shell><NotFoundVariant /></Shell>;

  // Terminal states first — a refetch may 404 once the CLI has consumed the
  // request; `done` is authoritative for what the user saw.
  if (done) return <Shell>{doneVariant(done, requestQuery.data)}</Shell>;
  if (requestQuery.data?.status === "approved") return <Shell><ApprovedVariant keyName={requestQuery.data.keyName} /></Shell>;
  if (requestQuery.error) return <Shell>{errorVariant(requestQuery.error)}</Shell>;
  if (requestQuery.isLoading) return null;
  const pending = requestQuery.data;
  if (!pending || pending.status !== "pending") return <Shell><NotFoundVariant /></Shell>;

  return (
    <Shell>
      <PendingVariant
        clientName={pending.clientName}
        code={pending.code}
        expiresAt={pending.expiresAt}
        busy={busy}
        onApprove={() => handleAction("approve")}
        onDeny={() => handleAction("deny")}
      />
    </Shell>
  );
}