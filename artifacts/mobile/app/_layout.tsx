import React, { useEffect } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ApiError } from '@workspace/api-client-react';
import { configureApiClient, notifyUnauthorized } from '@/lib/api';
import { ThemeProvider, useThemeContext } from '@/context/ThemeContext';
import { LanguageProvider, useLanguage } from '@/context/LanguageContext';
import { AuthProvider } from '@/context/AuthContext';
import { View } from 'react-native';

SplashScreen.preventAutoHideAsync();

// Point the generated API client at the HealthDocs server before anything renders.
configureApiClient();

// Session died mid-use (expired/revoked token): tell AuthContext so it can
// clear the stored token and send the user back to the login screen.
const onApiError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401) {
    notifyUnauthorized();
  }
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Client errors (401/403/404...) will not fix themselves — don't retry.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

function RootLayoutNav() {
  const { isRTL } = useLanguage();
  return (
    <View style={{ flex: 1, direction: isRTL ? 'rtl' : 'ltr' }}>
      <Stack screenOptions={{ headerBackTitle: 'Back', headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="credential/add" options={{ headerShown: true, title: 'Add Credential' }} />
        <Stack.Screen name="credential/[id]" options={{ headerShown: true, title: 'Credential Detail' }} />
        <Stack.Screen name="employee/[id]" options={{ headerShown: true, title: 'Employee Detail' }} />
        <Stack.Screen name="settings" options={{ headerShown: true, title: 'Settings' }} />
        <Stack.Screen name="integrations" options={{ headerShown: true, title: 'Integrations' }} />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <ThemeProvider>
                <LanguageProvider>
                  <AuthProvider>
                    <RootLayoutNav />
                  </AuthProvider>
                </LanguageProvider>
              </ThemeProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
