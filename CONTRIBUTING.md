# Contributing to Ondas

Thanks for helping improve Ondas. Please read the [Code of Conduct](CODE_OF_CONDUCT.md)
and [Security Policy](SECURITY.md) before participating. Do not file security reports
or include credentials, telemetry keys, or real chat content in public issues or pull
requests.

## Before you start

For substantial features or behavior changes, open an issue first so the change can be
discussed before implementation. Small bug fixes, tests, documentation corrections,
and focused accessibility improvements are welcome as pull requests.

The project currently uses:

- Xcode 26.4.1 (build 17E202).
- XcodeGen 2.45.4; this is the version pinned in the CI bootstrap script.
- Swift 6 with strict concurrency checking.

Apple Intelligence features require a supported device with Apple Intelligence enabled.
The app and tests can still be built on a Simulator, but the on-device model may report
itself unavailable there.

## Local setup

1. Fork the repository and clone your fork.
2. Create your local identity configuration as described in
   [README.md](README.md#running-your-own-fork). Never use the upstream project's
   signing team, bundle identifiers, App Groups, or CloudKit container for a fork.
3. Generate the ignored Xcode project:

   ```sh
   xcodegen generate --spec project.yml
   ```

4. Open `Ondas.xcodeproj` in Xcode and run the `Ondas` scheme on a simulator or a
   provisioned device. The local identity configuration supplies the signing team.

The generated `.xcodeproj` and `Info.plist` files are intentionally not committed.
Regenerate them after changing `project.yml` or identity configuration.

## Test before opening a pull request

Generate the project, then run the unit-test scheme against an installed iOS Simulator:

```sh
xcodegen generate --spec project.yml
xcodebuild test \
  -project Ondas.xcodeproj \
  -scheme Ondas \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max'
```

If that simulator name is not installed, choose an available iOS Simulator destination.
Include tests for behavior changes where feasible and call out anything that cannot be
tested on a simulator, especially Apple Intelligence, CloudKit, signing, and
Mac Catalyst behavior.

## Pull-request guidelines

- Keep each pull request focused and explain the user-facing change and its tradeoffs.
- Update tests and documentation with the code that changes documented behavior.
- Preserve the project's Swift 6 concurrency discipline; avoid suppressing warnings
  without explaining why it is safe.
- Do not commit generated Xcode projects, build output, provisioning profiles,
  certificates, private keys, API keys, telemetry endpoints, or real user data.
- Mention the Xcode/XcodeGen versions and device or simulator used when a change is
  sensitive to a particular Apple platform behavior.

## Licensing contributions

Unless you state otherwise in writing, submitting a contribution means you have the
right to submit it and license it under the repository's [GPL-3.0 license](LICENSE).
You retain ownership of your contribution, while granting everyone the rights required
by that license.
