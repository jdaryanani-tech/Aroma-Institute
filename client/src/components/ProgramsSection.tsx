import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, ArrowRight } from "lucide-react";
import programsBg from "@assets/pexels-sydnee-more-30355262-6936981_1771624143483.jpg";

const programs = [
  {
    title: "Professional Barista Certification",
    duration: "3 Months",
    description:
      "Master coffee foundations, espresso techniques, service skills, and café professionalism.",
    image: "/images/barista.png",
    tag: "Most Popular",
  },
  {
    title: "Advanced Brewing & Café Operations",
    duration: "6 Months",
    description:
      "Specialty brewing, operations training, leadership exposure, and paid internship experience.",
    image: "/images/brewing.png",
    tag: "Learn & Earn",
  },
  {
    title: "Professional Mixology & Mocktail Specialist",
    duration: "9 Months",
    description:
      "Craft mocktails, signature beverages, flavor science, and beverage menu engineering.",
    image: "/images/mocktails.png",
    tag: "Alcohol-Free",
  },
  {
    title: "Café Entrepreneur Incubation Program",
    duration: "12 Months",
    description:
      "From ideation to execution — build your own café with complete financial, operational, and launch planning.",
    image: "/images/entrepreneur.png",
    tag: "For Founders",
  },
];

export default function ProgramsSection() {
  const scrollTo = (href: string) => {
    const el = document.querySelector(href);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section
      id="programs"
      className="py-20 sm:py-28 relative overflow-hidden"
      data-testid="section-programs"
    >
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${programsBg})` }}
      />
      <div className="absolute inset-0 bg-card/40" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-2xl mx-auto mb-14"
        >
          <span className="text-primary font-semibold text-sm tracking-widest uppercase">
            Our Programs
          </span>
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground mt-3 leading-tight">
            Specialized Training <span className="text-primary italic">Programs</span>
          </h2>
          <p className="mt-4 text-muted-foreground text-base sm:text-lg leading-relaxed">
            Industry-focused programs designed to transform passionate individuals into
            skilled professionals and successful café entrepreneurs.
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 gap-6 lg:gap-8">
          {programs.map((program, index) => (
            <motion.div
              key={program.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.6, delay: index * 0.1 }}
            >
              <Card className="group h-full border-card-border bg-background hover-elevate" data-testid={`card-program-${index}`}>
                <div className="relative aspect-[16/10] overflow-hidden rounded-t-md">
                  <img
                    src={program.image}
                    alt={program.title}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                  <div className="absolute top-4 left-4">
                    <Badge variant="secondary" className="bg-primary text-primary-foreground text-xs">
                      {program.tag}
                    </Badge>
                  </div>
                </div>
                <CardContent className="p-6">
                  <div className="flex items-center gap-2 text-muted-foreground text-sm mb-3">
                    <Clock className="h-4 w-4" />
                    <span>{program.duration}</span>
                  </div>
                  <h3 className="font-serif text-xl sm:text-2xl font-bold text-foreground leading-snug">
                    {program.title}
                  </h3>
                  <p className="mt-3 text-muted-foreground text-sm sm:text-base leading-relaxed">
                    {program.description}
                  </p>
                  <Button
                    variant="outline"
                    className="mt-5 w-full"
                    onClick={() => scrollTo("#contact")}
                    data-testid={`button-view-details-${index}`}
                  >
                    View Details
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
