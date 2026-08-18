import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '@/context/AuthContext';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { ApiError } from '@workspace/api-client-react';
import type { DemoLoginInputRole } from '@workspace/api-client-react';

const DEMO_ROLES: { role: DemoLoginInputRole; icon: string }[] = [
  { role: 'system_admin', icon: 'settings' },
  { role: 'hospital_admin', icon: 'business' },
  { role: 'department_manager', icon: 'person-circle' },
  { role: 'supervisor', icon: 'people-circle' },
  { role: 'employee', icon: 'person' },
];

export default function LoginScreen() {
  const { login, completeTwoFactor, demoLogin } = useAuth();
  const colors = useColors();
  const { t, language, setLanguage, isRTL } = useLanguage();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState<DemoLoginInputRole | null>(null);
  const [error, setError] = useState('');
  // Non-null while the password was accepted and we await the OTP/backup code.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [twoFaCode, setTwoFaCode] = useState('');

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      setError(t('auth.invalidCredentials'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await login(email.trim(), password);
      if (result.pending2fa) {
        setChallengeToken(result.challengeToken);
        setTwoFaCode('');
        setPassword('');
        return;
      }
      router.replace('/(tabs)');
    } catch (err) {
      setError(t('auth.invalidCredentials'));
    } finally {
      setLoading(false);
    }
  };

  const cancelTwoFactor = () => {
    setChallengeToken(null);
    setTwoFaCode('');
    setError('');
  };

  const handleTwoFactor = async () => {
    if (!challengeToken || !twoFaCode.trim()) return;
    setLoading(true);
    setError('');
    try {
      await completeTwoFactor(challengeToken, twoFaCode.trim());
      router.replace('/(tabs)');
    } catch (err) {
      const code =
        err instanceof ApiError ? (err.data as { code?: string } | null)?.code : undefined;
      if (code === 'invalid_code') {
        setError(t('auth.twofa.invalidCode'));
        setTwoFaCode('');
      } else if (code === 'too_many_attempts') {
        cancelTwoFactor();
        setError(t('auth.twofa.tooMany'));
      } else {
        cancelTwoFactor();
        setError(t('auth.twofa.expired'));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDemoLogin = async (role: DemoLoginInputRole) => {
    if (demoLoading) return;
    setDemoLoading(role);
    setError('');
    try {
      await demoLogin(role);
      router.replace('/(tabs)');
    } catch (err) {
      setError(t('auth.demoFailed'));
    } finally {
      setDemoLoading(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <LinearGradient
        colors={[colors.primary, colors.background]}
        locations={[0, 0.4]}
        style={StyleSheet.absoluteFill}
      />

      <KeyboardAwareScrollViewCompat style={{ flex: 1 }} contentContainerStyle={{ padding: 24, paddingTop: Platform.OS === 'web' ? 67 : 80 }}>

        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 20 }}>
          <Pressable onPress={() => setLanguage(language === 'ar' ? 'en' : 'ar')} style={{ padding: 8, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 20 }}>
            <Text style={{ color: 'white', fontWeight: 'bold' }}>{language === 'ar' ? 'EN' : 'عربي'}</Text>
          </Pressable>
        </View>

        <View style={{ alignItems: 'center', marginBottom: 40 }}>
          <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: 'white', alignItems: 'center', justifyContent: 'center', marginBottom: 16, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10 }}>
            <Ionicons name="shield-checkmark" size={48} color={colors.primary} />
          </View>
          <Text style={{ fontSize: 32, fontWeight: 'bold', color: 'white' }}>MedCreds</Text>
          <Text style={{ fontSize: 16, color: 'rgba(255,255,255,0.8)', marginTop: 4 }}>إدارة الاعتمادات الصحية</Text>
        </View>

        {challengeToken ? (
          <View style={{ backgroundColor: colors.card, padding: 24, borderRadius: 16, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 15, elevation: 5 }}>
            <View style={{ alignItems: 'center', marginBottom: 16 }}>
              <Ionicons name="keypad" size={36} color={colors.primary} />
              <Text style={{ fontSize: 20, fontWeight: 'bold', color: colors.foreground, marginTop: 8 }}>
                {t('auth.twofa.title')}
              </Text>
              <Text style={{ color: colors.mutedForeground, textAlign: 'center', marginTop: 6 }}>
                {t('auth.twofa.hint')}
              </Text>
            </View>

            <TextInput
              style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: 'center', fontVariant: ['tabular-nums'], letterSpacing: 4 }]}
              placeholder={t('auth.twofa.codePlaceholder')}
              placeholderTextColor={colors.mutedForeground}
              value={twoFaCode}
              onChangeText={setTwoFaCode}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              onSubmitEditing={handleTwoFactor}
            />

            {error ? <Text style={{ color: colors.destructive, marginTop: 8, textAlign: 'center' }}>{error}</Text> : null}

            <Pressable
              style={[styles.btn, { backgroundColor: colors.primary, marginTop: 20, opacity: loading || !twoFaCode.trim() ? 0.7 : 1 }]}
              onPress={handleTwoFactor}
              disabled={loading || !twoFaCode.trim()}
            >
              {loading ? <ActivityIndicator color="white" /> : <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>{t('auth.twofa.verify')}</Text>}
            </Pressable>

            <Pressable onPress={cancelTwoFactor} style={{ marginTop: 16, alignItems: 'center' }} disabled={loading}>
              <Text style={{ color: colors.mutedForeground }}>{t('auth.twofa.cancel')}</Text>
            </Pressable>
          </View>
        ) : (
        <View style={{ backgroundColor: colors.card, padding: 24, borderRadius: 16, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 15, elevation: 5 }}>
          <TextInput
            style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}
            placeholder={t('auth.email')}
            placeholderTextColor={colors.mutedForeground}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />

          <View style={{ position: 'relative', marginTop: 16 }}>
            <TextInput
              style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: isRTL ? 'right' : 'left', paddingRight: isRTL ? 16 : 48, paddingLeft: isRTL ? 48 : 16 }]}
              placeholder={t('auth.password')}
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
            />
            <Pressable
              style={{ position: 'absolute', [isRTL ? 'left' : 'right']: 16, top: 14 }}
              onPress={() => setShowPassword(!showPassword)}
            >
              <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>

          {error ? <Text style={{ color: colors.destructive, marginTop: 8, textAlign: 'center' }}>{error}</Text> : null}

          <Pressable
            style={[styles.btn, { backgroundColor: colors.primary, marginTop: 24, opacity: loading ? 0.7 : 1 }]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color="white" /> : <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>{t('auth.signIn')}</Text>}
          </Pressable>

          <Pressable onPress={() => router.push('/(auth)/forgot')} style={{ marginTop: 16, alignItems: 'center' }}>
            <Text style={{ color: colors.primary }}>{t('auth.forgotPassword')}</Text>
          </Pressable>

          <Pressable onPress={() => router.push('/(auth)/register')} style={{ marginTop: 12, alignItems: 'center' }}>
            <Text style={{ color: colors.mutedForeground }}>
              {t('auth.noAccount')}{' '}
              <Text style={{ color: colors.primary, fontWeight: '600' }}>{t('auth.createAccount')}</Text>
            </Text>
          </Pressable>
        </View>
        )}

        {!challengeToken && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 30 }}>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
              <Text style={{ marginHorizontal: 16, color: colors.mutedForeground }}>{t('auth.or')}</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
            </View>

            <Text style={{ textAlign: 'center', color: colors.mutedForeground, marginBottom: 16 }}>{t('auth.demoAccounts')}</Text>

            <View style={{ gap: 12 }}>
              {DEMO_ROLES.map(({ role, icon }) => (
                <Pressable
                  key={role}
                  style={{ flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', backgroundColor: colors.card, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.border, opacity: demoLoading && demoLoading !== role ? 0.5 : 1 }}
                  onPress={() => handleDemoLogin(role)}
                  disabled={!!demoLoading}
                >
                  <Ionicons name={icon as any} size={24} color={colors.primary} />
                  <View style={{ flex: 1, paddingHorizontal: 12, alignItems: isRTL ? 'flex-end' : 'flex-start' }}>
                    <Text style={{ fontWeight: '600', color: colors.foreground }}>{t(`auth.roles.${role}`)}</Text>
                    <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>{t('auth.demoTap')}</Text>
                  </View>
                  {demoLoading === role ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <Ionicons name={isRTL ? 'chevron-back' : 'chevron-forward'} size={20} color={colors.mutedForeground} />
                  )}
                </Pressable>
              ))}
            </View>
          </>
        )}

        <View style={{ height: 40 }} />
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    height: 50,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  btn: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  }
});
