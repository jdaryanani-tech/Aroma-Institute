import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { BadgeIndianRupee, Users, CalendarClock, Award, Handshake } from "lucide-react";

const features = [
  {
    icon: BadgeIndianRupee,
    title: "Paid Internship Model",
    description: "Earn while you learn through structured paid internships at partner cafés.",
  },
  {
    icon: Users,
    title: "Real Customer Exposure",
    description: "Work directly with real customers in live café environments.",
  },
  {
    icon: CalendarClock,
    title: "Shift-Based Learning",
    description: "Flexible shift schedules combining classroom theory with practical shifts.",
  },
  {
    icon: Award,
    title: "Industry Mentorship",
    description: "Learn from experienced café owners and hospitality professionals.",
  },
  {
    icon: Handshake,
    title: "Placement Assistance",
    description: "Dedicated placement support connecting you with top hospitality brands.",
  },
];

export default function TrainingSection() {
  return (
    <section
      id="training"
      className="py-20 sm:py-28 bg-background relative overflow-hidden"
      data-testid="section-training"
    >
      <div className="absolute inset-0 opacity-5">
        <div className="absolute top-0 right-0 w-96 h-96 rounded-full bg-primary blur-3xl" />
        <div className="absolute bottom-0 left-0 w-96 h-96 rounded-full bg-primary blur-3xl" />
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-2xl mx-auto mb-14"
        >
          <span className="text-primary font-semibold text-sm tracking-widest uppercase">
            Learn & Earn
          </span>
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground mt-3 leading-tight">
            Industry-Integrated <span className="text-primary italic">Training Model</span>
          </h2>
          <p className="mt-4 text-muted-foreground text-base sm:text-lg leading-relaxed">
            Students attend structured daily classes and gain hands-on experience through real
            internship shifts inside operational cafés and partner hospitality brands.
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.08 }}
              className={index === 4 ? "sm:col-span-2 lg:col-span-1" : ""}
              data-testid={`training-feature-${index}`}
            >
              <Card className="p-6 h-full hover-elevate">
                <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center mb-4">
                  <feature.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold text-foreground text-lg">{feature.title}</h3>
                <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
                  {feature.description}
                </p>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
