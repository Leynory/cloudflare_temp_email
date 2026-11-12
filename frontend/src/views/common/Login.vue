<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useScopedI18n } from '@/i18n/app'
import { useRouter } from 'vue-router'
import { NewLabelOutlined, EmailOutlined, RedeemOutlined } from '@vicons/material'

// ИМПОРТ ФОНА
import bgImage from '@/assets/bg.png' 

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
        
        <!-- Центральный блок -->
        <div class="center-stage">
            
            <!-- Карточка с картинкой и формой -->
            <div class="main-card">
                
                <!-- Картинка с C.C. (задает размер) -->
                <img :src="bgImage" class="bg-image" alt="Background" />
                
                <!-- Переливающаяся неоновая рамка -->
                <div class="neon-border"></div>

                <!-- Баннер сверху -->
                <div class="welcome-banner">
                    <div class="lines top-lines"></div>
                    <h1 class="welcome-text">
                        <span class="welcome-w">W</span>
                        <span class="welcome-el">EL</span>
                        <span class="welcome-c">C</span>
                        <span class="welcome-o">O</span>
                        <span class="welcome-me">ME</span>
                    </h1>
                    <div class="swoosh"></div>
                    <div class="lines bottom-lines"></div>
                    <p class="welcome-subtext">GACHA SUKI MAIL</p>
                </div>

                <!-- Форма входа по центру -->
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
                                    <n-button v-if="!openSettings.disableCustomAddressName" @click="generateName" style="margin-bottom: 10px;">
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
/* --- Контейнер (Чистый черный фон, без сетки и свечения) --- */
.login-layout {
    position: relative;
    width: 100%;
    min-height: 85vh;
    display: flex;
    justify-content: center;
    align-items: center;
    background-color: #050505; /* Глубокий черный цвет для краев */
    overflow: hidden;
}

/* =========================================
   ЦЕНТРАЛЬНАЯ КАРТОЧКА
   ========================================= */

.center-stage {
    position: relative;
    z-index: 10;
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    padding: 20px;
}

.main-card {
    position: relative;
    /* Ширина 80vw гарантирует, что картинка не растянется на весь экран */
    width: 80vw; 
    max-width: 1200px;
    display: flex;
    justify-content: center;
    align-items: center;
}

/* Картинка (всегда сохраняет пропорции) */
.bg-image {
    width: 100%;
    height: auto; 
    display: block;
    border-radius: 12px;
    z-index: 1;
}

/* =========================================
   ГРАДИЕНТНАЯ РАМКА
   ========================================= */
.neon-border {
    position: absolute;
    inset: -6px;
    border-radius: 16px;
    pointer-events: none;
    z-index: 2;
    
    background: linear-gradient(
        135deg, 
        #001a09 0%, 
        #008f33 25%, 
        #004d1a 50%, 
        #008f33 75%, 
        #001a09 100%
    );
    background-size: 300% 300%; 
    animation: travel 3s linear infinite;
    
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    
    padding: 4px; 
    filter: drop-shadow(0 0 8px rgba(0, 143, 51, 0.5));
}

@keyframes travel {
    0% { background-position: 0% 0%; }
    100% { background-position: 100% 100%; }
}

/* =========================================
   БАННЕР И ФОРМА (ПОВЕРХ КАРТИНКИ)
   ========================================= */

/* --- Баннер --- */
.welcome-banner {
    position: absolute;
    top: 10%; 
    left: 50%;
    transform: translateX(-50%);
    z-index: 10;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: none; 
}

.welcome-text {
    font-family: 'Playfair Display', 'Times New Roman', serif;
    font-size: 3.5rem; 
    font-weight: 900;
    margin: 0;
    color: #ffffff;
    letter-spacing: -2px; 
    line-height: 1;
    text-shadow: 0 0 15px rgba(0, 143, 51, 0.6); 
}

.lines {
    width: 180px; 
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.8), transparent);
    position: relative;
    margin: 8px 0;
}
.top-lines::before, .top-lines::after,
.bottom-lines::before, .bottom-lines::after {
    content: '';
    position: absolute;
    width: 30px;
    height: 1px;
    background: rgba(255, 255, 255, 0.5);
    top: 50%;
}
.top-lines::before, .bottom-lines::before { right: 100%; margin-right: 10px; }
.top-lines::after, .bottom-lines::after { left: 100%; margin-left: 10px; }

.swoosh {
    position: absolute;
    top: 40%;
    left: 20%;
    width: 60%;
    height: 30px;
    border-top: 2px solid #004d1a; 
    border-radius: 50%;
    transform: rotate(-5deg);
    pointer-events: none;
    opacity: 0.6;
}

.welcome-subtext {
    color: #a0a0a0;
    font-family: sans-serif;
    letter-spacing: 4px;
    text-transform: uppercase;
    font-size: 0.7rem;
    margin-top: 8px;
}

/* --- Форма входа --- */
.login-form-wrapper {
    position: absolute;
    top: 55%; 
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 10;
    
    width: 320px; 
    background-color: rgba(10, 12, 10, 0.85); 
    backdrop-filter: blur(15px); 
    padding: 20px; 
    border-radius: 12px;
    box-shadow: 
        0 10px 40px rgba(0, 0, 0, 0.9), 
        inset 0 0 0 1px rgba(0, 143, 51, 0.3); 
}

/* --- Мобильная версия --- */
@media (max-width: 850px) {
    .login-form-wrapper { width: 90%; max-width: 320px; padding: 15px; top: 58%; }
    .welcome-banner { top: 8%; }
    .welcome-text { font-size: 2.5rem; letter-spacing: -1px; }
    .swoosh { display: none; }
    .lines { width: 120px; }
    .main-card { width: 95vw; }
}

/* --- Твои изначальные стили --- */
.n-alert { margin-top: 10px; margin-bottom: 10px; text-align: center; }
.n-form .n-button { margin-top: 8px; }
.redeem-entry-section { margin-top: 12px; }
.redeem-entry-section :deep(.n-divider) { margin: 0 0 10px; }
.redeem-entry-tip { display: block; font-size: 11px; line-height: 1.4; text-align: center; }
.switch-login-button { display: flex; justify-content: center; margin: 5px 0; }
.n-form { text-align: left; }
</style>
