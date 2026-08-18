import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { forgotPassword } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';

export default function ForgotScreen() {
  const colors = useColors();
  const { t, isRTL } = useLanguage();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSend = async () => {
    if (!email.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await forgotPassword({ email: email.trim() });
      setSent(true);
    } catch {
      setError(t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, padding: 24, paddingTop: Platform.OS === 'web' ? 67 : 60 }}>
      <Pressable onPress={() => router.back()} style={{ marginBottom: 24, alignSelf: 'flex-start' }}>
        <Ionicons name={isRTL ? 'arrow-forward' : 'arrow-back'} size={24} color={colors.foreground} />
      </Pressable>

      <Text style={{ fontSize: 28, fontWeight: 'bold', color: colors.foreground, marginBottom: 8, textAlign: isRTL ? 'right' : 'left' }}>
        {t('auth.forgotPassword')}
      </Text>

      {sent ? (
        <View style={{ marginTop: 24, alignItems: 'center' }}>
          <Ionicons name="checkmark-circle" size={64} color={colors.success} />
          <Text style={{ color: colors.foreground, fontSize: 16, textAlign: 'center', marginTop: 16 }}>
            {t('auth.resetSent')}
          </Text>
        </View>
      ) : (
        <View style={{ marginTop: 24 }}>
          <TextInput
            style={[styles.input, { backgroundColor: colors.input, borderColor: colors.border, color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}
            placeholder={t('auth.email')}
            placeholderTextColor={colors.mutedForeground}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          {error ? <Text style={{ color: colors.destructive, marginTop: 8 }}>{error}</Text> : null}
          <Pressable
            style={[styles.btn, { backgroundColor: colors.primary, marginTop: 24, opacity: loading ? 0.7 : 1 }]}
            onPress={handleSend}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color="white" /> : (
              <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>{t('auth.sendReset')}</Text>
            )}
          </Pressable>
        </View>
      )}
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
