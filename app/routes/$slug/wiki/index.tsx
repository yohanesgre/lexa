import { createFileRoute } from "@tanstack/react-router";
import { WikiLayout } from "../../../components/wiki/WikiLayout";

export const Route = createFileRoute("/$slug/wiki/")({
  component: WikiIndexPage,
});

function WikiIndexPage() {
  const { slug } = Route.useParams();
  return (
    <WikiLayout slug={slug}>
      {() => (
        <div className="flex items-center justify-center h-full text-lx-text-muted">
          <div className="text-center">
            <p className="text-sm">Select a page from the sidebar to start reading.</p>
          </div>
        </div>
      )}
    </WikiLayout>
  );
}
