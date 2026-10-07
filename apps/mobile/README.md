# apps/mobile

Expo + React Native app (Expo Router, NativeWind, TanStack Query, Zustand, `expo-auth-session`).
Not generated yet: it lands in build-order step 4. Create it with:

```sh
cd apps && pnpm create expo-app@latest mobile --template default
```

then rename the package to `@speaksplit/mobile` and add `@speaksplit/split-engine` and
`@speaksplit/api-types` as `workspace:*` dependencies.
