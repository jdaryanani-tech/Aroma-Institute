import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { FileText, MessageSquare, CheckCircle, BookOpen } from "lucide-react";

const steps = [
  {
    icon: FileText,
    step: "Step 1",
    title: "Application",
    description: "Fill out the online application form with your details and program preference.",
  },
  {
    icon: MessageSquare,
    step: "Step 2",
    title: "Screening Interview",
    description: "A brief screening call to understand your goals and assess program fit.",
  },
  {
    icon: CheckCircle,
    step: "Step 3",
    title: "Admission Confirmation",
    description: "Receive your admission offer letter and complete the enrollment process.",
  },
  {
    icon: BookOpen,
    step: "Step 4",
    title: "Orientation & Training Begins",
    description: "Join the orientation session and begin your practical training journey.",
  },
];

export default function AdmissionSection() {
  return (
    <section
      id="admissions"
      className="py-20 sm:py-28 bg-background"
      data-testid="section-admissions"
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
            How to Join
          </span>
          <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground mt-3 leading-tight">
            Admission <span className="text-primary italic">Process</span>
          </h2>
          <p className="mt-4 text-muted-foreground text-base sm:text-lg leading-relaxed">
            A simple, streamlined admission process to get you started on your café career journey.
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {steps.map((step, index) => (
            <motion.div
              key={step.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              className="relative"
              data-testid={`admission-step-${index}`}
            >
              {index < steps.length - 1 && (
                <div className="hidden lg:block absolute top-10 left-[calc(50%+32px)] w-[calc(100%-32px)] h-px bg-border" />
              )}

              <Card className="text-center p-6">
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <step.icon className="h-6 w-6 text-primary" />
                </div>
                <span className="text-xs font-bold text-primary tracking-widest uppercase">
                  {step.step}
                </span>
                <h3 className="font-semibold text-foreground text-lg mt-2">{step.title}</h3>
                <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
                  {step.description}
                </p>
              </Card>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="mt-10 text-center"
        >
          <div className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary/10 text-primary text-sm font-medium">
            <CheckCircle className="h-4 w-4" />
            Flexible EMI options available
          </div>
        </motion.div>
      </div>
    </section>
  );
}
