import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ArrowRight, Phone } from "lucide-react";
import ctaBg from "@assets/pexels-quang-nguyen-vinh-222549-2159065_1771624542454.jpg";

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
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${ctaBg})` }}
      />
      <div className="absolute inset-0 bg-primary/40" />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
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
          <p className="mt-6 text-base sm:text-lg max-w-2xl mx-auto leading-relaxed bg-[#fff0f087] text-[#000000]">
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
