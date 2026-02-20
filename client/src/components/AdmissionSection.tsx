import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { CheckCircle } from "lucide-react";
import admissionBg from "@assets/pexels-julieaagaard-2467287_1771624608263.jpg";
import step1Img from "@/assets/images/admission-step1-application.png";
import step2Img from "@/assets/images/admission-step2-interview.png";
import step3Img from "@/assets/images/admission-step3-confirmation.png";
import step4Img from "@/assets/images/admission-step4-orientation.png";

const steps = [
  {
    image: step1Img,
    step: "Step 1",
    title: "Application",
    description: "Fill out the online application form with your details and program preference.",
  },
  {
    image: step2Img,
    step: "Step 2",
    title: "Screening Interview",
    description: "A brief screening call to understand your goals and assess program fit.",
  },
  {
    image: step3Img,
    step: "Step 3",
    title: "Admission Confirmation",
    description: "Receive your admission offer letter and complete the enrollment process.",
  },
  {
    image: step4Img,
    step: "Step 4",
    title: "Orientation & Training Begins",
    description: "Join the orientation session and begin your practical training journey.",
  },
];

export default function AdmissionSection() {
  return (
    <section
      id="admissions"
      className="py-20 sm:py-28 relative overflow-hidden"
      data-testid="section-admissions"
    >
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${admissionBg})` }}
      />
      <div className="absolute inset-0 bg-background/60" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
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
                <div className="w-20 h-20 rounded-full overflow-hidden mx-auto mb-4">
                  <img src={step.image} alt={step.title} className="w-full h-full object-cover" />
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
