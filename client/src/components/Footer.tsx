import { SiInstagram, SiFacebook, SiLinkedin, SiYoutube } from "react-icons/si";

const socialLinks = [
  { icon: SiInstagram, label: "Instagram", href: "#" },
  { icon: SiFacebook, label: "Facebook", href: "#" },
  { icon: SiLinkedin, label: "LinkedIn", href: "#" },
  { icon: SiYoutube, label: "YouTube", href: "#" },
];

const quickLinks = [
  { label: "About Us", href: "#about" },
  { label: "Programs", href: "#programs" },
  { label: "Placements", href: "#placements" },
  { label: "Admissions", href: "#admissions" },
  { label: "Contact", href: "#contact" },
];

const programLinks = [
  "Professional Barista Certification",
  "Advanced Brewing & Café Operations",
  "Mixology & Mocktail Specialist",
  "Café Entrepreneur Incubation",
];

export default function Footer() {
  const scrollTo = (href: string) => {
    const el = document.querySelector(href);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <footer className="bg-foreground text-background" data-testid="section-footer">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-10">
          <div className="sm:col-span-2 lg:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-10 h-10 rounded-md bg-primary flex items-center justify-center">
                <span className="text-primary-foreground font-serif font-bold text-xl">U</span>
              </div>
              <div>
                <span className="font-serif font-bold text-lg text-background">Urja</span>
                <span className="block text-[10px] leading-tight font-medium tracking-wider uppercase text-background/60">
                  School of Café & Hospitality
                </span>
              </div>
            </div>
            <p className="text-background/60 text-sm leading-relaxed mt-4">
              India's practical, industry-integrated hospitality academy where students
              Learn, Intern, Earn, and Launch.
            </p>
            <div className="flex items-center gap-3 mt-6">
              {socialLinks.map((social) => (
                <a
                  key={social.label}
                  href={social.href}
                  className="w-9 h-9 rounded-md bg-background/10 flex items-center justify-center text-background/70 hover:bg-primary hover:text-primary-foreground transition-colors"
                  aria-label={social.label}
                  data-testid={`link-social-${social.label.toLowerCase()}`}
                >
                  <social.icon className="h-4 w-4" />
                </a>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-background text-sm mb-4 tracking-wider uppercase">
              Quick Links
            </h4>
            <ul className="space-y-2.5">
              {quickLinks.map((link) => (
                <li key={link.label}>
                  <button
                    onClick={() => scrollTo(link.href)}
                    className="text-background/60 text-sm hover:text-primary transition-colors"
                    data-testid={`link-footer-${link.label.toLowerCase().replace(/\s/g, '-')}`}
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-background text-sm mb-4 tracking-wider uppercase">
              Programs
            </h4>
            <ul className="space-y-2.5">
              {programLinks.map((program) => (
                <li key={program}>
                  <button
                    onClick={() => scrollTo("#programs")}
                    className="text-background/60 text-sm hover:text-primary transition-colors text-left"
                  >
                    {program}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-background text-sm mb-4 tracking-wider uppercase">
              Contact
            </h4>
            <div className="space-y-2.5 text-background/60 text-sm">
              <p>Gurukul Road, Memnagar, Ahmedabad, Gujarat, India</p>
              <p>+91 98765 43210</p>
              <p>admissions@urjaschool.in</p>
            </div>
          </div>
        </div>

        <div className="mt-12 pt-8 border-t border-background/10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-background/40 text-xs" data-testid="text-copyright">
            &copy; {new Date().getFullYear()} Urja School of Cafe & Hospitality Management. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <button className="text-background/40 text-xs hover:text-background/60 transition-colors">
              Privacy Policy
            </button>
            <button className="text-background/40 text-xs hover:text-background/60 transition-colors">
              Terms of Service
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
