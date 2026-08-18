import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useGetFacilities, ApiError } from '@workspace/api-client-react';
import { useAuth } from '@/context/AuthContext';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';

export default function RegisterScreen() {
  const { register } = useAuth();
  const colors = useColors();
  const { t, isRTL } = useLanguage();

  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [phone, setPhone] = useState('');
  const [facilityId, setFacilityId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Public endpoint — no session needed for the dropdown.
  const { data: facilities } = useGetFacilities();
  const facilityOptions = facilities ?? [];

  // A single facility needs no choice — preselect it.
  useEffect(() => {
    if (facilityId == null && facilityOptions.length === 1) {
      setFacilityId(facilityOptions[0].id);
    }
  }, [facilityOptions, facilityId]);

  const handleRegister = async () => {
    if (loading) return;
    if (!nameAr.trim() || !nameEn.trim() || !email.trim() || !password) {
      setError(t('auth.register.failed'));
      return;
    }
    if (password.length < 8) {
      setError(t('auth.register.passwordHint'));
      return;
    }
    if (facilityId == null) {
      setError(t('auth.register.facility'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      await register({
        name: nameEn.trim(),
        nameAr: nameAr.trim(),
        email: email.trim(),
        password,
        phone: phone.trim() ? phone.trim() : null,
        facilityId,
      });
      router.replace('/(tabs)');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(t('auth.register.emailTaken'));
      } else {
        setError(t('auth.register.failed'));
      }
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = [
    styles.input,
    {
      backgroundColor: colors.input,
      borderColor: colors.border,
      color: colors.foreground,
      textAlign: (isRTL ? 'right' : 'left') as 'right' | 'left',
    },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAwareScrollViewCompat
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 24, paddingTop: Platform.OS === 'web' ? 67 : 60 }}
      >
        <Pressable
          onPress={() => router.back()}
          style={{ marginBottom: 24, alignSelf: 'flex-start' }}
        >
          <Ionicons
            name={isRTL ? 'arrow-forward' : 'arrow-back'}
            size={24}
            color={colors.foreground}
          />
        </Pressable>

        <Text
          style={{
            fontSize: 28,
            fontWeight: 'bold',
            color: colors.foreground,
            textAlign: isRTL ? 'right' : 'left',
          }}
        >
          {t('auth.register.title')}
        </Text>
        <Text
          style={{
            fontSize: 15,
            color: colors.mutedForeground,
            marginTop: 6,
            marginBottom: 24,
            textAlign: isRTL ? 'right' : 'left',
          }}
        >
          {t('auth.register.subtitle')}
        </Text>

        <View
          style={{
            backgroundColor: colors.card,
            padding: 20,
            borderRadius: 16,
            gap: 14,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <TextInput
            style={inputStyle}
            placeholder={t('auth.register.nameAr')}
            placeholderTextColor={colors.mutedForeground}
            value={nameAr}
            onChangeText={setNameAr}
          />
          <TextInput
            style={inputStyle}
            placeholder={t('auth.register.nameEn')}
            placeholderTextColor={colors.mutedForeground}
            value={nameEn}
            onChangeText={setNameEn}
            autoCapitalize="words"
          />
          <TextInput
            style={inputStyle}
            placeholder={t('auth.email')}
            placeholderTextColor={colors.mutedForeground}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />

          <View style={{ position: 'relative' }}>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.input,
                  borderColor: colors.border,
                  color: colors.foreground,
                  textAlign: (isRTL ? 'right' : 'left') as 'right' | 'left',
                  paddingRight: isRTL ? 16 : 48,
                  paddingLeft: isRTL ? 48 : 16,
                },
              ]}
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
              <Ionicons
                name={showPassword ? 'eye-off' : 'eye'}
                size={20}
                color={colors.mutedForeground}
              />
            </Pressable>
          </View>
          <Text style={{ fontSize: 12, color: colors.mutedForeground, textAlign: isRTL ? 'right' : 'left' }}>
            {t('auth.register.passwordHint')}
          </Text>

          <TextInput
            style={inputStyle}
            placeholder={t('auth.register.phone')}
            placeholderTextColor={colors.mutedForeground}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
          />

          <Text
            style={{
              fontWeight: '600',
              color: colors.foreground,
              marginTop: 4,
              textAlign: isRTL ? 'right' : 'left',
            }}
          >
            {t('auth.register.facility')}
          </Text>
          {facilityOptions.map((f) => (
            <Pressable
              key={f.id}
              onPress={() => setFacilityId(f.id)}
              style={{
                flexDirection: isRTL ? 'row-reverse' : 'row',
                alignItems: 'center',
                gap: 10,
                padding: 14,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: facilityId === f.id ? colors.primary : colors.border,
                backgroundColor: facilityId === f.id ? colors.primary + '12' : colors.input,
              }}
            >
              <Ionicons
                name={facilityId === f.id ? 'checkmark-circle' : 'ellipse-outline'}
                size={22}
                color={facilityId === f.id ? colors.primary : colors.mutedForeground}
              />
              <Text style={{ color: colors.foreground, flex: 1, textAlign: isRTL ? 'right' : 'left' }}>
                {isRTL ? f.nameAr : f.name}
              </Text>
            </Pressable>
          ))}

          {error ? (
            <Text style={{ color: colors.destructive, textAlign: 'center' }}>{error}</Text>
          ) : null}

          <Pressable
            style={[
              styles.btn,
              { backgroundColor: colors.primary, marginTop: 8, opacity: loading ? 0.7 : 1 },
            ]}
            onPress={handleRegister}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>
                {t('auth.register.submit')}
              </Text>
            )}
          </Pressable>
        </View>

        <Pressable
          onPress={() => router.back()}
          style={{ marginTop: 20, alignItems: 'center' }}
        >
          <Text style={{ color: colors.primary }}>{t('auth.register.haveAccount')}</Text>
        </Pressable>

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
  },
});
