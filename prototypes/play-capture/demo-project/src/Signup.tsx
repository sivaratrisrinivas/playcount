import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

const SignupSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type SignupValues = z.infer<typeof SignupSchema>;

export function Signup() {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupValues>({ resolver: zodResolver(SignupSchema) });

  return (
    <form onSubmit={handleSubmit((values) => console.log(values))}>
      <input type="email" {...register("email")} />
      {errors.email && <p role="alert">{errors.email.message}</p>}
      <input type="password" {...register("password")} />
      {errors.password && <p role="alert">{errors.password.message}</p>}
      <button>Sign up</button>
    </form>
  );
}
