import { useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { GraduationCap, Briefcase, Globe, Coffee, Rocket } from "lucide-react";

const highlights = [
  { icon: Briefcase, label: "Learn While You Earn Model" },
  { icon: GraduationCap, label: "100% Placement Assistance" },
  { icon: Globe, label: "Multilingual Learning Support" },
  { icon: Coffee, label: "Real Café Internship Exposure" },
  { icon: Rocket, label: "Founder Incubation Program" },
];

export default function AboutSection() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.play().catch(() => {});
    }
  }, []);

  return (
    <section
      id="about"
      className="py-20 sm:py-28 relative overflow-hidden"
      data-testid="section-about"
    >
      <video
        ref={videoRef}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        className="absolute inset-0 w-full h-full object-cover"
        data-testid="about-bg-video"
      >
        <source src="/images/about-bg.mp4" type="video/mp4" />
      </video>
      <div className="absolute inset-0 bg-background/40" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-20 items-center">
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.7 }}
          >
            <span className="text-primary font-semibold text-sm tracking-widest uppercase">
              About Us
            </span>
            <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground mt-3 leading-tight">
              About <span className="text-primary italic">Urja</span>
            </h2>
            <p className="mt-6 text-muted-foreground text-base sm:text-lg leading-relaxed">
              Urja School of Cafe & Hospitality Management is a practical hospitality academy
              focused on developing job-ready professionals and launch-ready café entrepreneurs.
            </p>
            <p className="mt-4 text-muted-foreground text-base sm:text-lg leading-relaxed">
              We provide structured classroom training combined with real-world internships inside
              live cafés. Our programs are designed for ambitious students and future founders who
              want real industry exposure — not just theory.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.7, delay: 0.2 }}
          >
            <div className="space-y-4">
              {highlights.map((item, index) => (
                <motion.div
                  key={item.label}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  data-testid={`about-highlight-${index}`}
                >
                  <Card className="flex items-center gap-4 p-4 hover-elevate">
                    <div className="flex-shrink-0 w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center">
                      <item.icon className="h-5 w-5 text-primary" />
                    </div>
                    <span className="font-medium text-foreground text-sm sm:text-base">
                      {item.label}
                    </span>
                  </Card>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
