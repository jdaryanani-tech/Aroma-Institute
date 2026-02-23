import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Menu, X } from "lucide-react";
import aromaLogo from "@assets/ChatGPT_Image_Feb_24__2026__01_47_11_AM-removebg-preview_1771878331386.png";

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
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 bg-[#000000de]">
        <div className="flex items-center justify-between h-auto py-3">
          <button
            onClick={() => scrollTo("#hero")}
            className="flex items-center gap-3 shrink-0"
            data-testid="link-home"
          >
            <img
              src={aromaLogo}
              alt="Aroma Institute Logo"
              className="h-12 sm:h-14 w-auto object-contain"
            />
            <div className="hidden sm:block text-left">
              <span className="font-serif tracking-tight text-2xl sm:text-3xl font-black text-white leading-none block">AROMA</span>
              <span className="block tracking-wider uppercase text-white/70 text-[10px] sm:text-xs font-light leading-tight mt-0.5">Institute of Cafe & Hospitality Management</span>
            </div>
          </button>

          <div className="hidden lg:flex items-center gap-1">
            {navLinks.map((link) => (
              <button
                key={link.href}
                onClick={() => scrollTo(link.href)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
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
