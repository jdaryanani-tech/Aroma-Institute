import { useEffect, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import footerLogo from "@assets/ChatGPT_Image_Feb_24__2026__01_50_58_AM-removebg-preview_1771878331387.png";

type CompliancePageLayoutProps = {
  title: string;
  description: string;
  children: ReactNode;
};

export default function CompliancePageLayout({
  title,
  description,
  children,
}: CompliancePageLayoutProps) {
  useEffect(() => {
    const previousTitle = document.title;
    const descriptionTag = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const createdDescriptionTag = !descriptionTag;
    const metaDescription = descriptionTag ?? document.createElement("meta");

    if (createdDescriptionTag) {
      metaDescription.name = "description";
      document.head.appendChild(metaDescription);
    }

    const previousDescription = metaDescription.content;
    document.title = title;
    metaDescription.content = description;

    return () => {
      document.title = previousTitle;
      if (createdDescriptionTag) {
        metaDescription.remove();
      } else {
        metaDescription.content = previousDescription;
      }
    };
  }, [description, title]);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="bg-[#1c1917] text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <a href="/" className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <img src={footerLogo} alt="" className="h-11 w-11 shrink-0 rounded-md object-contain" />
            <span className="min-w-0">
              <span className="block font-serif text-lg font-bold leading-tight sm:text-xl">Aroma Institute</span>
              <span className="block text-[10px] leading-tight tracking-wider text-white/65 sm:text-xs">
                Cafe &amp; Hospitality Management
              </span>
            </span>
          </a>
          <a
            href="/"
            className="inline-flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-white/85 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back to homepage
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
        <article className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-8 lg:p-10">
          <div className="mb-8 border-b border-border pb-6 sm:mb-10">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Aroma Institute of Cafe &amp; Hospitality Management
            </p>
            <h1 className="font-serif text-3xl font-bold leading-tight text-foreground sm:text-4xl">{title}</h1>
          </div>
          <div className="space-y-8 text-sm leading-7 text-muted-foreground sm:text-base">
            {children}
          </div>
          <div className="mt-10 border-t border-border pt-6">
            <a
              href="/"
              className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              Return to homepage
            </a>
          </div>
        </article>
      </main>

      <footer className="border-t border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p className="text-muted-foreground">Aroma Institute of Cafe &amp; Hospitality Management</p>
          <nav aria-label="Compliance pages" className="flex flex-wrap gap-x-5 gap-y-2">
            <a className="text-primary underline-offset-4 hover:underline" href="/privacy-policy">Privacy Policy</a>
            <a className="text-primary underline-offset-4 hover:underline" href="/data-deletion">Data Deletion Instructions</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
