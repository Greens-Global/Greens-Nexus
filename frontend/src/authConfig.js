export const msalConfig = {
  auth: {
    clientId: "be6f1e37-83a8-4a29-8b46-96d20beb32f9",
    authority: "https://login.microsoftonline.com/40966012-b88e-45c8-941a-341f87b9dc60",
    redirectUri: "https://vlow2k.github.io/Greens-Nexus/",
    postLogoutRedirectUri: "https://vlow2k.github.io/Greens-Nexus/",
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
};

export const loginRequest = {
  scopes: ["User.Read"],
};
