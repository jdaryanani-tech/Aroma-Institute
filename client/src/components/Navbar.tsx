import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Menu, X } from "lucide-react";

const navLinks = [
  { label: "About", href: "#about" },
  { label: "Programs", href: "#programs" },
  { label: "Training Model", href: "#training" },
  { label: "Placements", href: "#placements" },
  { label: "Admissions", href: "#admissions" },
  { label: "Contact", href: "#contact" },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handler);
    return () => window.removeEventListener("scroll", handler);
  }, []);

  const scrollTo = (href: string) => {
    setOpen(false);
    const el = document.querySelector(href);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <nav
      data-testid="navbar"
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-background/95 backdrop-blur-md border-b border-border shadow-sm"
          : "bg-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-4 h-16 sm:h-20 relative">
          <div className="shrink-0" />
          <button
            onClick={() => scrollTo("#hero")}
            className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2"
            data-testid="link-home"
          >
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-md bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-serif font-bold text-lg sm:text-xl">U</span>
            </div>
            <div className="hidden sm:block">
              <span className={`font-serif font-bold text-lg tracking-tight ${scrolled ? "text-foreground" : "text-white"}`}>URJA</span>
              <span className={`block text-[10px] leading-tight font-medium tracking-wider uppercase ${scrolled ? "text-muted-foreground" : "text-white/70"}`}>School of Café & Hospitality Management</span>
            </div>
          </button>

          <div className="hidden lg:flex items-center gap-1">
            {navLinks.map((link) => (
              <button
                key={link.href}
                onClick={() => scrollTo(link.href)}
                className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                  scrolled
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-white/80 hover:text-white"
                }`}
                data-testid={`link-${link.label.toLowerCase()}`}
              >
                {link.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={() => scrollTo("#contact")}
              data-testid="button-apply-nav"
            >
              Apply Now
            </Button>

            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className={`lg:hidden ${scrolled ? "" : "text-white"}`}
                  data-testid="button-mobile-menu"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72 bg-background">
                <div className="flex flex-col gap-1 mt-8">
                  {navLinks.map((link) => (
                    <button
                      key={link.href}
                      onClick={() => scrollTo(link.href)}
                      className="px-4 py-3 text-left text-sm font-medium text-foreground rounded-md hover:bg-accent transition-colors"
                      data-testid={`link-mobile-${link.label.toLowerCase()}`}
                    >
                      {link.label}
                    </button>
                  ))}
                  <div className="mt-4 px-4">
                    <Button
                      className="w-full"
                      onClick={() => scrollTo("#contact")}
                      data-testid="button-apply-mobile"
                    >
                      Apply Now
                    </Button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </nav>
  );
}
