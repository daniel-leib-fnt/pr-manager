{
  description = "pr-manager: dashboard and sticky Claude agent sessions for GitHub pull requests";

  # nixpkgs is pinned on purpose and not meant to follow the consumer: the Agent SDK version in
  # package.json must match the claude-code version from this pin (SDK 0.3.x <-> claude-code 2.1.x).
  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs {
        inherit system;
        config.allowUnfreePredicate = p: nixpkgs.lib.getName p == "claude-code";
      }));
    in
    {
      packages = forAll (pkgs: {
        default = pkgs.callPackage ./nix/package.nix { };
      });

      homeManagerModules.default = import ./nix/module.nix self;

      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs_22 pkgs.claude-code ]; };
      });
    };
}
