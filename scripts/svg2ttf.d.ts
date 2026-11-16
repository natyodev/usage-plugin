declare module "svg2ttf" {
  interface Options {
    /** Unix seconds stamped as the font's created and modified time, in place of the build time. */
    readonly ts?: number;
    readonly version?: string;
  }

  export default function svg2ttf(svgFont: string, options?: Options): { readonly buffer: Uint8Array };
}
