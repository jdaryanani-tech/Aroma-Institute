import { counsellingAnswersSchema } from "@shared/schema";

export function validateCounsellingAnswer(key:string,value:unknown) {
  if(!Object.prototype.hasOwnProperty.call(counsellingAnswersSchema.shape,key))
    return {valid:false as const,code:"unknown_question"};
  const field=counsellingAnswersSchema.shape[key as keyof typeof counsellingAnswersSchema.shape];
  const result=field.safeParse(value);
  return result.success
    ? {valid:true as const,value:result.data}
    : {valid:false as const,code:"invalid_answer"};
}
