export type Session = {
  status: "loading" | "anonymous" | "authenticated";
  user?: User;
};
type User = import("./api").User;
