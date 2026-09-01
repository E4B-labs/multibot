declare module "flubber" {
  export function interpolate(
    fromShape: string,
    toShape: string,
    options?: { maxSegmentLength?: number; string?: boolean },
  ): (t: number) => string;
}
