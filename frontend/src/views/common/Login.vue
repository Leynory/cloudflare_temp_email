<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { useRouter } from 'vue-router'
import { NewLabelOutlined, EmailOutlined, RedeemOutlined } from '@vicons/material'

import ccImage from '@/assets/cc.png' 

import AdminContact from '../common/AdminContact.vue'
import Turnstile from '../../components/Turnstile.vue'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { getRouterPathWithLang, hashPassword } from '../../utils'

const props = defineProps({
    bindUserAddress: {
        type: Function,
        default: async () => { await api.bindUserAddress(); },
        required: true
    },
    newAddressPath: {
        type: Function,
        default: async (address_name, domain, cf_token, enableRandomSubdomain) => {
            return await api.fetch("/api/new_address", {
                method: "POST",
                body: JSON.stringify({
                    name: address_name,
                    domain: domain,
                    cf_token: cf_token,
                    enableRandomSubdomain: enableRandomSubdomain,
                }),
            });
        },
        required: true
    },
})

const message = useMessage()
const notification = useNotification()
const router = useRouter()

const {
    jwt, loading, openSettings,
    showAddressCredential, userSettings, addressPassword
} = useGlobalState()

const tabValue = ref('signin')
const credential = ref('')
const emailName = ref("")
const emailDomain = ref("")
const cfToken = ref("")
const subdomainMode = ref("normal")
const customSubdomain = ref("")
const loginCfToken = ref("")
const loginTurnstileRef = ref(null)
const loginMethod = ref('credential')
const loginAddress = ref('')
const loginPassword = ref('')

const initLoginMethod = () => {
    if (openSettings.value?.enableAddressPassword) {
        loginMethod.value = 'password';
    } else {
        loginMethod.value = 'credential';
    }
}

const login = async () => {
    if (loginMethod.value === 'password') {
        if (!loginAddress.value || !loginPassword.value) {
            message.error(t('emailPasswordRequired'));
            return;
        }
        try {
            const res = await api.fetch('/api/address_login', {
                method: 'POST',
                body: JSON.stringify({
                    email: loginAddress.value,
                    password: await hashPassword(loginPassword.value),
                    cf_token: loginCfToken.value
                })
            });
            jwt.value = res.jwt;
            await api.getSettings();
            try { await props.bindUserAddress(); } catch (error) { message.error(`${t('bindUserAddressError')}: ${error.message}`); }
            await router.push(getRouterPathWithLang("/", locale.value));
        } catch (error) {
            message.error(error.message || "error");
            loginTurnstileRef.value?.refresh?.();
        }
        return;
    }
    if (!credential.value) {
        message.error(t('credentialInput'));
        return;
    }
    try {
        await api.fetch('/open_api/credential_login', {
            method: 'POST',
            body: JSON.stringify({ credential: credential.value, cf_token: loginCfToken.value })
        });
        jwt.value = credential.value;
        await api.getSettings();
        try { await props.bindUserAddress(); } catch (error) { message.error(`${t('bindUserAddressError')}: ${error.message}`); }
        await router.push(getRouterPathWithLang("/", locale.value));
    } catch (error) {
        message.error(error.message || "error");
        loginTurnstileRef.value?.refresh?.();
    }
}

const { locale, t } = useScopedI18n('views.common.Login')

const loginAndBindTag = computed(() => userSettings.value.user_email ? t('loginAndBind') : t('login'))

const addressRegex = computed(() => {
    try {
        if (openSettings.value.addressRegex) return new RegExp(openSettings.value.addressRegex, 'g');
    } catch (error) {
        console.error(error);
        message.error(`Invalid addressRegex: ${openSettings.value.addressRegex}`);
    }
    return /[^a-z0-9]/g;
});

const generateNameLoading = ref(false);
const generateName = async () => {
    try {
        generateNameLoading.value = true;
        const { faker } = await import('https://esm.sh/@faker-js/faker');
        emailName.value = faker.internet.email().split('@')[0].replace(/\s+/g, '.').replace(/\.{2,}/g, '.').replace(addressRegex.value, '').toLowerCase();
        if (emailName.value.length > openSettings.value.maxAddressLen) {
            emailName.value = emailName.value.slice(0, openSettings.value.maxAddressLen);
        }
    } catch (error) { message.error(error.message || "error"); } finally { generateNameLoading.value = false; }
};

const newEmail = async () => {
    try {
        const nameToSend = openSettings.value.disableCustomAddressName ? "" : emailName.value;
        const domainToSend = subdomainMode.value === "custom" ? `${customSubdomain.value.trim()}.${emailDomain.value}` : emailDomain.value;
        const res = await props.newAddressPath(nameToSend, domainToSend, cfToken.value, subdomainMode.value === "random");
        jwt.value = res["jwt"];
        addressPassword.value = res["password"] || '';
        await api.getSettings();
        await router.push(getRouterPathWithLang("/", locale.value));
        showAddressCredential.value = true;
        try { await props.bindUserAddress(); } catch (error) { message.error(`${t('bindUserAddressError')}: ${error.message}`); }
    } catch (error) { message.error(error.message || "error"); }
};

const openRedeemPage = async () => { await router.push(getRouterPathWithLang('/redeem', locale.value)); };

const addressPrefix = computed(() => userSettings.value?.user_role ? userSettings.value.user_role.prefix || "" : openSettings.value.prefix);

const canUseRandomSubdomain = computed(() => {
    if (!emailDomain.value) return false;
    return (openSettings.value.randomSubdomainDomains || []).includes(emailDomain.value);
});

watch(canUseRandomSubdomain, (enabled) => { if (!enabled) subdomainMode.value = "normal"; });

const domainsOptions = computed(() => {
    if (userSettings.value.user_role) {
        const allDomains = userSettings.value.user_role.domains;
        if (!allDomains) return openSettings.value.domains;
        return openSettings.value.domains.filter((domain) => allDomains.includes(domain.value));
    }
    if (!openSettings.value.defaultDomains) return openSettings.value.domains;
    return openSettings.value.domains.filter((domain) => openSettings.value.defaultDomains.includes(domain.value));
});

const showNewAddressTab = computed(() => {
    if (openSettings.value.disableAnonymousUserCreateEmail && !userSettings.value.user_email) return false;
    return openSettings.value.enableUserCreateEmail;
});

onMounted(async () => {
    if (!openSettings.value.domains || openSettings.value.domains.length === 0) {
        await api.getOpenSettings(message, notification);
    }
    emailDomain.value = domainsOptions.value ? domainsOptions.value[0]?.value : "";
    initLoginMethod();
});
</script>

<template>
    <div class="login-layout">
        <!-- ЯРКАЯ КИБЕРПАНК СЕТКА -->
        <div class="cyber-grid"></div>
        
        <!-- Светящиеся сферы -->
        <div class="glow-sphere sphere-1"></div>
        <div class="glow-sphere sphere-2"></div>

        <!-- РАМКА -->
        <div class="neon-frame">
            
            <!-- C.C. Слева -->
            <img :src="ccImage" class="cc-character left" alt="C.C." />
            
            <!-- C.C. Справа -->
            <img :src="ccImage" class="cc-character right" alt="C.C." />

            <!-- СЛОЙ С ЛИНИЯМИ РАМКИ -->
            <div class="frame-lines-overlay">
                <!-- ТОЛСТАЯ НЕПРОЗРАЧНАЯ ПАНЕЛЬ СВЕРХУ -->
                <div class="frame-top-line"></div>
            </div>

            <!-- Контент -->
            <div class="content-wrapper">
                
                <!-- Баннер -->
                <div class="welcome-banner">
                    <div class="lines top-lines"></div>
                    <h1 class="welcome-text">
                        <span class="welcome-w">W</span>
                        <span class="welcome-el">EL</span>
                        <span class="welcome-c">C</span>
                        <span class="welcome-o">O</span>
                        <span class="welcome-me">ME</span>
                    </h1>
                    <div class="lines bottom-lines"></div>
                    <p class="welcome-subtext">GACHA SUKI MAIL</p>
                </div>

                <!-- Форма входа -->
                <div class="login-form-wrapper">
                    <n-alert v-if="userSettings.user_email" :show-icon="false" :bordered="false" closable>
                        <span>{{ t('bindUserInfo') }}</span>
                    </n-alert>
                    
                    <n-tabs v-if="openSettings.fetched" v-model:value="tabValue" size="medium" justify-content="space-evenly">
                        <n-tab-pane name="signin" :tab="loginAndBindTag">
                            <n-form size="medium">
                                <div v-if="loginMethod === 'password'">
                                    <n-form-item-row :label="t('email')" required>
                                        <n-input v-model:value="loginAddress" />
                                    </n-form-item-row>
                                    <n-form-item-row :label="t('password')" required>
                                        <n-input v-model:value="loginPassword" type="password" show-password-on="click"
                                            @keyup.enter="login" />
                                    </n-form-item-row>
                                </div>
                                <div v-else>
                                    <n-form-item-row :label="t('credential')" required>
                                        <n-input v-model:value="credential" type="textarea" :autosize="{ minRows: 2 }" />
                                    </n-form-item-row>
                                </div>

                                <Turnstile ref="loginTurnstileRef" v-if="openSettings.enableGlobalTurnstileCheck" v-model:value="loginCfToken" />

                                <div class="switch-login-button">
                                    <n-button v-if="openSettings?.enableAddressPassword && !openSettings.addressPasswordLoginOnly"
                                        @click="loginMethod === 'password' ? loginMethod = 'credential' : loginMethod = 'password'"
                                        type="info" quaternary size="small">
                                        {{ loginMethod === 'password' ? t('credentialLogin') : t('passwordLogin') }}
                                    </n-button>
                                </div>

                                <n-button @click="login" :loading="loading" type="primary" block secondary strong size="medium">
                                    <template #icon><n-icon :component="EmailOutlined" /></template>
                                    {{ loginAndBindTag }}
                                </n-button>
                                <n-button v-if="showNewAddressTab" @click="tabValue = 'register'" block secondary strong size="medium">
                                    <template #icon><n-icon :component="NewLabelOutlined" /></template>
                                    {{ t('getNewEmail') }}
                                </n-button>
                                <div v-if="openSettings.enableRedeemCode" class="redeem-entry-section">
                                    <n-divider />
                                    <n-text type="info" class="redeem-entry-tip">{{ t('redeemEntryTip') }}</n-text>
                                    <n-button data-testid="redeem-entry" block secondary strong size="medium" @click="openRedeemPage">
                                        <template #icon><n-icon :component="RedeemOutlined" /></template>
                                        {{ t('useRedeemCode') }}
                                    </n-button>
                                </div>
                            </n-form>
                        </n-tab-pane>
                        
                        <n-tab-pane v-if="showNewAddressTab" name="register" :tab="t('getNewEmail')">
                            <n-spin :show="generateNameLoading">
                                <n-form size="medium">
                                    <span>
                                        <p v-if="!openSettings.disableCustomAddressName">{{ t("getNewEmailTip1") + addressRegex.source }}</p>
                                        <p v-if="!openSettings.disableCustomAddressName">{{ t("getNewEmailTip2") }}</p>
                                        <p>{{ t("getNewEmailTip3") }}</p>
                                    </span>
                                    <n-button v-if="!openSettings.disableCustomAddressName" @click="generateName" style="margin-bottom: 10px;" size="small">
                                        {{ t('generateName') }}
                                    </n-button>
                                    <n-input-group>
                                        <n-input-group-label v-if="addressPrefix">{{ addressPrefix }}</n-input-group-label>
                                        <n-input v-if="!openSettings.disableCustomAddressName" v-model:value="emailName" show-count :minlength="openSettings.minAddressLen" :maxlength="openSettings.maxAddressLen" />
                                        <n-input v-else :value="t('autoGeneratedName')" disabled />
                                        <n-input-group-label>@</n-input-group-label>
                                        <n-select v-model:value="emailDomain" :consistent-menu-width="false" :options="domainsOptions" />
                                    </n-input-group>
                                    <n-form-item-row v-if="canUseRandomSubdomain">
                                        <div style="width: 100%;">
                                            <n-radio-group v-model:value="subdomainMode">
                                                <n-space vertical>
                                                    <n-radio value="normal">{{ t('normalSubdomain') }}</n-radio>
                                                    <n-radio value="random">{{ t('enableRandomSubdomain') }}</n-radio>
                                                    <n-radio value="custom">{{ t('enableCustomSubdomain') }}</n-radio>
                                                </n-space>
                                            </n-radio-group>
                                            <p v-if="subdomainMode === 'random'" style="margin: 8px 0 0; opacity: 0.75;">{{ t('randomSubdomainTip') }}</p>
                                            <n-input-group v-if="subdomainMode === 'custom'" style="margin-top: 8px;">
                                                <n-input v-model:value="customSubdomain" />
                                                <n-input-group-label>.{{ emailDomain }}</n-input-group-label>
                                            </n-input-group>
                                        </div>
                                    </n-form-item-row>
                                    <Turnstile v-model:value="cfToken" />
                                    <n-button type="primary" block secondary strong size="medium" @click="newEmail" :loading="loading" :disabled="subdomainMode === 'custom' && !customSubdomain.trim()">
                                        <template #icon><n-icon :component="NewLabelOutlined" /></template>
                                        {{ t('getNewEmail') }}
                                    </n-button>
                                    <div v-if="openSettings.enableRedeemCode" class="redeem-entry-section">
                                        <n-divider />
                                        <n-text type="info" class="redeem-entry-tip">{{ t('redeemEntryTip') }}</n-text>
                                        <n-button data-testid="redeem-entry-register" block secondary strong size="medium" @click="openRedeemPage">
                                            <template #icon><n-icon :component="RedeemOutlined" /></template>
                                            {{ t('useRedeemCode') }}
                                        </n-button>
                                    </div>
                                </n-form>
                            </n-spin>
                        </n-tab-pane>
                        <n-tab-pane name="help" :tab="t('help')">
                            <n-alert :show-icon="false" :bordered="false">
                                <span>{{ t('pleaseGetNewEmail') }}</span>
                            </n-alert>
                            <AdminContact />
                        </n-tab-pane>
                    </n-tabs>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* --- ДЕКЛАРАЦИЯ ПЕРЕМЕННОЙ ДЛЯ АНИМАЦИИ --- */
@property --angle {
  syntax: "<angle>";
  initial-value: 0deg;
  inherits: false;
}

/* --- ГЛОБАЛЬНЫЙ ФОН И РАЗМЕТКА --- */
.login-layout {
    position: relative;
    width: 100vw;
    left: 50%;
    right: 50%;
    margin-left: -50vw;
    margin-right: -50vw;
    min-height: 100vh;
    background-color: #050508; 
    background-image: radial-gradient(circle at center, #11181a 0%, #050508 70%);
    overflow: hidden;
    display: flex;
    justify-content: center;
    align-items: center;
}

/* --- ЯРКАЯ КИБЕРПАНК СЕТКА --- */
.cyber-grid {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background-image: 
        linear-gradient(rgba(0, 255, 136, 0.15) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 255, 136, 0.15) 1px, transparent 1px);
    background-size: 30px 30px;
    z-index: 0;
}

/* --- СВЕТЯЩИЕСЯ СФЕРЫ --- */
.glow-sphere {
    position: absolute;
    border-radius: 50%;
    filter: blur(80px);
    z-index: 1;
    opacity: 0.3;
}
.sphere-1 {
    width: 400px; height: 400px;
    background: rgba(0, 255, 136, 0.4);
    top: 10%; left: 10%;
}
.sphere-2 {
    width: 500px; height: 500px;
    background: rgba(0, 100, 50, 0.2); 
    bottom: 5%; right: 10%;
}

/* =========================================
   РАМКА
   ========================================= */
.neon-frame {
    position: relative;
    width: 85vw; 
    max-width: 1300px; 
    height: 85vh; 
    background-color: rgba(5, 10, 8, 0.5); 
    z-index: 5;
    display: flex;
    flex-direction: column;
    overflow: hidden; 
}

/* =========================================
   C.C.
   ========================================= */
.cc-character {
    position: absolute;
    bottom: 0; 
    height: 95%; 
    width: auto; 
    object-fit: contain;
    object-position: bottom;
    z-index: 2; 
    pointer-events: none;
}

.cc-character.left {
    left: 0; 
}

.cc-character.right {
    right: 0; 
    transform: scaleX(-1); 
}

/* =========================================
   ЛИНИИ РАМКИ
   ========================================= */
.frame-lines-overlay {
    position: absolute;
    inset: 0;
    border: 3px solid #00ff88;
    box-shadow: 
        0 0 20px rgba(0, 255, 136, 0.2), 
        inset 0 0 20px rgba(0, 255, 136, 0.1);
    z-index: 999; 
    pointer-events: none;
}

.frame-top-line {
    width: 100%;
    height: 80px; 
    background-color: #0a0e0c; 
    border-bottom: 2px solid #00ff88;
    box-shadow: 0 2px 10px rgba(0, 255, 136, 0.3);
}

/* =========================================
   КОНТЕНТ (ИСПОЛЬЗУЕМ GRID ДЛЯ ИДЕАЛЬНОГО ЦЕНТРИРОВАНИЯ)
   ========================================= */
.content-wrapper {
    position: absolute; /* Абсолютное позиционирование, чтобы сетка не влияла */
    top: 80px; /* Отступ под верхнюю панель */
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20; 
    display: grid;
    place-items: center; /* Центрирует всё и по горизонтали, и по вертикали */
    padding: 20px;
}

/* Внутренняя обертка, чтобы баннер и форма стояли друг под другом */
.content-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
}

/* --- БАННЕР --- */
.welcome-banner {
    position: relative;
    text-align: center;
    margin-bottom: 20px; 
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-left: auto;
    margin-right: auto;
}

.welcome-text {
    font-family: 'Playfair Display', 'Times New Roman', serif;
    font-size: 3rem; 
    font-weight: 900;
    margin: 0;
    color: #ffffff;
    letter-spacing: -2px; 
    line-height: 1;
    text-shadow: 0 0 15px rgba(0, 255, 136, 0.5); 
}

.lines {
    width: 160px; 
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(0, 255, 136, 0.8), transparent);
    position: relative;
    margin: 6px 0;
}
.top-lines::before, .top-lines::after,
.bottom-lines::before, .bottom-lines::after {
    content: '';
    position: absolute;
    width: 25px;
    height: 1px;
    background: rgba(0, 255, 136, 0.5);
    top: 50%;
}
.top-lines::before, .bottom-lines::before { right: 100%; margin-right: 8px; }
.top-lines::after, .bottom-lines::after { left: 100%; margin-left: 8px; }

.welcome-subtext {
    color: #a0a0a0;
    font-family: sans-serif;
    letter-spacing: 4px;
    text-transform: uppercase;
    font-size: 0.65rem; 
    margin-top: 6px;
}

/* =========================================
   ФОРМА ВХОДА
   ========================================= */
.login-form-wrapper {
    position: relative; 
    width: 340px; 
    flex-shrink: 0; 
    background-color: rgba(10, 15, 12, 0.9); 
    backdrop-filter: blur(15px); 
    padding: 25px 20px; 
    border-radius: 8px; 
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.9); 
    
    /* Принудительное центрирование на всякий случай */
    margin-left: auto; 
    margin-right: auto;
}

.login-form-wrapper::before {
    content: "";
    position: absolute;
    inset: 0; 
    border-radius: 8px; 
    padding: 2px; 
    
    background: conic-gradient(
        from var(--angle),
        transparent 60%,
        rgba(0, 255, 136, 0.9) 75%,
        #ffffff 85%,
        rgba(0, 255, 136, 0.9) 95%,
        transparent 100%
    );
    
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    
    animation: rotate-shimmer 2.5s linear infinite;
    pointer-events: none;
    z-index: 11; 
}

@keyframes rotate-shimmer {
    to { --angle: 360deg; }
}

/* --- Мобильная версия --- */
@media (max-width: 850px) {
    .login-form-wrapper { width: 90%; max-width: 340px; }
    .welcome-text { font-size: 2.2rem; letter-spacing: -1px; }
    .lines { width: 120px; }
    .cc-character { height: 90%; opacity: 0.15; } 
    .neon-frame { width: 95vw; height: 85vh; }
    .frame-top-line { height: 60px; }
    .content-wrapper { top: 60px; }
}

/* --- Твои изначальные стили --- */
.n-alert { margin-top: 10px; margin-bottom: 10px; text-align: center; }
.n-form .n-button { margin-top: 10px; }
.redeem-entry-section { margin-top: 15px; }
.redeem-entry-section :deep(.n-divider) { margin: 0 0 12px; }
.redeem-entry-tip { display: block; font-size: 11px; line-height: 1.4; text-align: center; }
.switch-login-button { display: flex; justify-content: center; margin: 5px 0; }
.n-form { text-align: left; }
</style>
