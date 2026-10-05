declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./fixtures/worker");
    durableNamespaces: "WorkspaceDO" | "BotDO" | "ComputerDO" | "RealComputerDO";
  }
}
