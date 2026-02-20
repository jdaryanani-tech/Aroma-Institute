import { motion } from "framer-motion";
import kaffaLogo from "@assets/images-removebg-preview_(1)_1771621764244.png";
import ccdLogo from "@assets/Café_Coffee_Day.svg-removebg-preview_1771621764243.png";
import starbucksLogo from "@assets/Starbucks_Corporation_Logo_2011.svg-removebg-preview_1771621764245.png";
import brewgartenLogo from "@assets/images-removebg-preview_1771621764246.png";
import sipOfHopeLogo from "@assets/SIP_of_Hope-removebg-preview_1771621764247.png";
import korebiLogo from "@assets/images__2_-removebg-preview_1771621764248.png";
import blueTokaiLogo from "@assets/blue-tokai-logo_1771621764248.webp";
import fyroLogo from "@assets/images_(1)_1771621764250.png";

const partners = [
  { name: "Kaffa Coffee Roasters", logo: kaffaLogo },
  { name: "Café Coffee Day", logo: ccdLogo },
  { name: "Starbucks", logo: starbucksLogo },
  { name: "Cafe Brewgarten", logo: brewgartenLogo },
  { name: "Sip of Hope", logo: sipOfHopeLogo },
  { name: "Korebi Coffee Roasters", logo: korebiLogo },
  { name: "Blue Tokai Coffee", logo: blueTokaiLogo },
  { name: "FYRO", logo: fyroLogo },
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
              className="flex items-center justify-center p-4 sm:p-6 rounded-lg bg-background border border-border hover-elevate aspect-square"
              data-testid={`partner-logo-${index}`}
            >
              <img
                src={partner.logo}
                alt={partner.name}
                className="w-full h-full object-contain p-2"
              />
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
