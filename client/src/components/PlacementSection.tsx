import { motion } from "framer-motion";
import { Building2 } from "lucide-react";
import kaffaLogo from "@assets/images_1771621355563.jpg";

const partners = [
  { name: "Kaffa Coffee Roasters", logo: kaffaLogo },
  { name: "Third Wave Coffee", logo: null },
  { name: "Blue Tokai", logo: null },
  { name: "Starbucks India", logo: null },
  { name: "The Coffee House", logo: null },
  { name: "Barista Coffee Co.", logo: null },
  { name: "Chaayos", logo: null },
  { name: "Dyu Art Café", logo: null },
];

export default function PlacementSection() {
  return (
    <section
      id="placements"
      className="py-20 sm:py-28 bg-card"
      data-testid="section-placements"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-2xl mx-auto mb-14"
        >
          <span className="text-primary font-semibold text-sm tracking-widest uppercase">
            Industry Network
          </span>
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground mt-3 leading-tight">
            Industry Tie-Ups & <span className="text-primary italic">Placement Assistance</span>
          </h2>
          <p className="mt-4 text-muted-foreground text-base sm:text-lg leading-relaxed">
            We provide 100% placement assistance through our network of cafés, hotels,
            beverage brands, and hospitality partners across Gujarat and beyond.
          </p>
        </motion.div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6">
          {partners.map((partner, index) => (
            <motion.div
              key={partner.name}
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: index * 0.05 }}
              className="flex flex-col items-center justify-center p-6 sm:p-8 rounded-lg bg-background border border-border hover-elevate"
              data-testid={`partner-logo-${index}`}
            >
              {partner.logo ? (
                <img src={partner.logo} alt={partner.name} className="w-16 h-16 object-contain mb-3 rounded-md" />
              ) : (
                <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center mb-3">
                  <Building2 className="h-6 w-6 text-muted-foreground" />
                </div>
              )}
              <span className="text-sm font-medium text-foreground text-center">{partner.name}</span>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-12 text-center"
        >
          <p className="text-muted-foreground text-sm">
            ...and many more hospitality brands across Gujarat and India
          </p>
        </motion.div>
      </div>
    </section>
  );
}
