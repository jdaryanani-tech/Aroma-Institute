import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ArrowRight, Phone } from "lucide-react";

export default function CTASection() {
  const scrollTo = (href: string) => {
    const el = document.querySelector(href);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section
      className="py-20 sm:py-28 relative overflow-hidden"
      data-testid="section-cta"
    >
      <div className="absolute inset-0 bg-primary" />
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-0 right-0 w-96 h-96 rounded-full bg-white blur-3xl" />
        <div className="absolute bottom-0 left-0 w-64 h-64 rounded-full bg-white blur-3xl" />
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center"
        >
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-primary-foreground leading-tight">
            Ready to Start Your Career or Launch Your Café?
          </h2>
          <p className="mt-6 text-primary-foreground/80 text-base sm:text-lg max-w-2xl mx-auto leading-relaxed">
            Take the first step toward a rewarding career in the café and hospitality industry.
            Apply now or speak with our counselors to find the right program for you.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <Button
              size="lg"
              variant="secondary"
              onClick={() => scrollTo("#contact")}
              className="text-base px-8"
              data-testid="button-apply-cta"
            >
              Apply Now
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => scrollTo("#contact")}
              className="text-base px-8 bg-white/10 border-white/30 text-white"
              data-testid="button-counseling-cta"
            >
              <Phone className="mr-2 h-4 w-4" />
              Book Counseling Call
            </Button>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
