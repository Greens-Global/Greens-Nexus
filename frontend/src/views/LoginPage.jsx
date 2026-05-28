import { useMsal } from "@azure/msal-react";
import { loginRequest } from "../authConfig";

export default function LoginPage() {
  const { instance } = useMsal();

  function handleLogin() {
    instance.loginRedirect(loginRequest);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <span className="login-logo-icon">G</span>
        </div>
        <h1 className="login-title">Greens Nexus</h1>
        <p className="login-subtitle">Sign in with your Greens Global account</p>
        <button className="login-btn" onClick={handleLogin}>
          <svg width="20" height="20" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="10" height="10" fill="#F35325" />
            <rect x="11" width="10" height="10" fill="#81BC06" />
            <rect y="11" width="10" height="10" fill="#05A6F0" />
            <rect x="11" y="11" width="10" height="10" fill="#FFBA08" />
          </svg>
          Sign in with Microsoft
        </button>
      </div>
    </div>
  );
}
