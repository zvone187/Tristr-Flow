import SwiftUI

struct SignInView: View {
    @Environment(AccountSession.self) private var account
    @State private var email = ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case email, password }

    var body: some View {
        Form {
            Section {
                TextField("Email", text: $email)
                    .keyboardType(.emailAddress)
                    .textContentType(.username)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($focus, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
                    .accessibilityIdentifier("signInEmail")
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .accessibilityIdentifier("signInPassword")
            } header: {
                Text("Sign in to Tristr Flow")
            }
            Section {
                Button(action: submit) {
                    HStack {
                        Spacer()
                        if account.phase == .signingIn {
                            ProgressView("Signing in…")
                        } else {
                            Text("Sign In").fontWeight(.semibold)
                        }
                        Spacer()
                    }
                }
                .disabled(!canSubmit)
                .accessibilityIdentifier("signInSubmit")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    if let message = account.message {
                        Text(message).foregroundStyle(.red)
                            .accessibilityIdentifier("signInMessage")
                    }
                    Text("Tristr Flow collects anonymous usage events, including app opens and sign-in results.")
                    Link("Privacy policy", destination: URL(string: "https://tristr-flow-5iy7.onrender.com/privacy")!)
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private var canSubmit: Bool {
        account.phase == .signedOut && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
    }

    private func submit() {
        guard canSubmit else { return }
        focus = nil
        let address = email
        let enteredPassword = password
        password = ""
        Task { await account.signIn(email: address, password: enteredPassword) }
    }
}
