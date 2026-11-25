import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy · ApplyPilot" },
      {
        name: "description",
        content:
          "How ApplyPilot, a private single-user job application tool, handles the owner's data.",
      },
      { property: "og:title", content: "Privacy Policy · ApplyPilot" },
      {
        property: "og:description",
        content:
          "How ApplyPilot, a private single-user job application tool, handles the owner's data.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background px-4 py-12 text-foreground">
      <div className="mx-auto max-w-2xl space-y-6 text-sm leading-relaxed">
        <header>
          <h1 className="text-2xl font-semibold">Privacy Policy</h1>
          <p className="mt-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
            ApplyPilot
          </p>
        </header>

        <p>
          ApplyPilot is a private, single-user job application tool. It stores
          the owner's resume, profile and job applications.
        </p>

        <p>
          With Gmail access connected it reads the owner's email to detect
          application confirmations and account verification codes, and sends
          replies on their behalf.
        </p>

        <p>No data is shared with third parties and nothing is sold.</p>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">Site visitor data</h2>
          <p>
            This site's host, Lovable, adds a small analytics script to every
            page. It uses no cookies, stores nothing on the visitor's device,
            does not keep IP addresses and does not identify visitors. Lovable
            collects this data for us.{" "}
            <a
              href="https://lovable.dev/privacy"
              className="text-primary underline underline-offset-2"
            >
              Lovable's privacy policy
            </a>{" "}
            explains how it handles it.
          </p>
          <p>For every visitor it records:</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>the pages visited and where the visitor came from</li>
            <li>the visitor's country, browser, operating system and device type</li>
            <li>how long they stay, how fast pages load, and errors</li>
            <li>which buttons and links are clicked</li>
          </ul>
          <p>
            This site has no consent banner, so all of the above is recorded for
            every visitor. Detailed data is kept for 90 days; daily summaries are
            kept for a year.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">Contact</h2>
          <p>
            Questions about this page:{" "}
            <a
              href="mailto:thomasdeluca0727@gmail.com"
              className="text-primary underline underline-offset-2"
            >
              thomasdeluca0727@gmail.com
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}
