declare module "gi://*" {
  const namespace: any;
  export default namespace;
}

/** GJS's own binding, which is not behind `gi://`. */
declare module "cairo" {
  const namespace: any;
  export default namespace;
}

/** Imported `with { type: "text" }`, which Bun bundles as the file's text. */
declare module "*.css" {
  const text: string;
  export default text;
}
