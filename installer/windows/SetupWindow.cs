using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Principal;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shell;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;
using Shape = System.Windows.Shapes.Path;

namespace Pull.Setup
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            var app = new Application();
            using (var theme = Assembly.GetExecutingAssembly().GetManifestResourceStream("Pull.Theme"))
                app.Resources.MergedDictionaries.Add((ResourceDictionary)XamlReader.Load(theme));

            if (args.Length == 4 && args[0] == "--update-window")
            {
                var progress = new SetupWindow(Layout.Compact, args[1], args[2]);
                progress.ContentRendered += delegate { File.WriteAllText(args[3], "ready"); };
                app.Run(progress);
            }
            else
            {
#if SIDEBAR
                const Layout layout = Layout.Sidebar;
#elif STEPS
                const Layout layout = Layout.Steps;
#else
                const Layout layout = Layout.Compact;
#endif
                app.Run(new SetupWindow(layout, null, null));
            }
        }
    }

    internal enum Layout { Compact, Sidebar, Steps }

    internal sealed class SetupWindow : Window
    {
        private readonly Layout layout;
        private readonly string updateMarker;
        private readonly string version;
        private readonly ImageSource logo;
        private readonly Grid content = new Grid();
        private readonly Button closeButton;
        private RadioButton machineChoice;
        private TextBox directory;
        private CheckBox launch;
        private TextBlock error;
        private bool allUsers;
        private bool launchAfter = true;
        private bool busy;
        private int step;
        private string installDirectory;

        internal SetupWindow(Layout layout, string updateMarker, string requestedVersion)
        {
            this.layout = layout;
            this.updateMarker = updateMarker;
            version = requestedVersion ?? Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            if (requestedVersion == null)
            {
                var versionPath = Assembly.GetExecutingAssembly().GetManifestResourceStream("Pull.Version");
                if (versionPath != null)
                    using (versionPath)
                    using (var text = new StreamReader(versionPath))
                        version = text.ReadToEnd().Trim();
            }
            using (var image = Assembly.GetExecutingAssembly().GetManifestResourceStream("Pull.Logo"))
            {
                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.StreamSource = image;
                bitmap.EndInit();
                bitmap.Freeze();
                logo = bitmap;
            }

            Title = updateMarker == null ? "PULL — установка" : "PULL — обновление";
            Icon = logo;
            Width = updateMarker != null ? 480 : layout == Layout.Sidebar ? 780 : 650;
            Height = updateMarker != null ? 280 : layout == Layout.Sidebar ? 460 : 440;
            MinWidth = updateMarker != null ? 440 : layout == Layout.Sidebar ? 640 : 540;
            MinHeight = updateMarker != null ? 260 : 435;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.CanResize;
            FontFamily = new FontFamily("Segoe UI");
            FontSize = 14;
            Background = Color("Background");
            Foreground = Color("Ink");
            WindowChrome.SetWindowChrome(this, new WindowChrome {
                CaptionHeight = 36, GlassFrameThickness = new Thickness(0),
                ResizeBorderThickness = new Thickness(5), CornerRadius = new CornerRadius(9),
                UseAeroCaptionButtons = false
            });

            var shell = new DockPanel { LastChildFill = true, Background = Background };
            var caption = new DockPanel { Height = 37, LastChildFill = true, Background = Background };
            var captionButtons = new StackPanel { Orientation = Orientation.Horizontal };
            WindowChrome.SetIsHitTestVisibleInChrome(captionButtons, true);
            DockPanel.SetDock(captionButtons, Dock.Right);
            caption.Children.Add(captionButtons);
            captionButtons.Children.Add(CaptionButton("Свернуть", "M1,6 H11", delegate { WindowState = WindowState.Minimized; }));
            var maximize = CaptionButton("Развернуть", "M2,2 H10 V10 H2 Z", delegate {
                WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
            });
            captionButtons.Children.Add(maximize);
            StateChanged += delegate {
                var maximized = WindowState == WindowState.Maximized;
                maximize.Content = Glyph(maximized ? "M2,4 H8 V10 H2 Z M4,2 H10 V8" : "M2,2 H10 V10 H2 Z");
                var name = maximized ? "Восстановить окно" : "Развернуть";
                maximize.ToolTip = name;
                AutomationProperties.SetName(maximize, name);
            };
            closeButton = CaptionButton("Закрыть", "M2,2 L10,10 M10,2 L2,10", delegate { Close(); });
            captionButtons.Children.Add(closeButton);
            var brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(16, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            brand.Children.Add(new Image { Source = logo, Width = 18, Height = 18 });
            brand.Children.Add(Text("PULL", 13, "Ink", true, new Thickness(8, 0, 0, 0)));
            brand.Children.Add(Text(updateMarker == null ? "/  Установка" : "/  Обновление", 12, "Muted", false, new Thickness(8, 1, 0, 0)));
            caption.Children.Add(brand);
            var titleBar = new Border { BorderBrush = Color("Line"), BorderThickness = new Thickness(0, 0, 0, 1), Child = caption };
            DockPanel.SetDock(titleBar, Dock.Top);
            shell.Children.Add(titleBar);
            shell.Children.Add(content);
            Content = shell;
            Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) { if (busy) e.Cancel = true; };

            if (updateMarker == null)
            {
                allUsers = SetupPayload.ReadInstallValue(false, "InstallLocation") == null &&
                    SetupPayload.ReadInstallValue(true, "InstallLocation") != null;
                installDirectory = DefaultDirectory(allUsers);
                ShowSetup();
            }
            else
            {
                ShowProgress(true);
                TrackUpdate();
            }
        }

        private static Brush Color(string key) { return (Brush)Application.Current.FindResource(key); }

        private static TextBlock Text(string value, double size, string brush, bool bold, Thickness margin)
        {
            return new TextBlock {
                Text = value, FontSize = size, Foreground = Color(brush),
                FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
                Margin = margin, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap
            };
        }

        private static Shape Glyph(string geometry)
        {
            return new Shape { Data = Geometry.Parse(geometry), Stroke = Color("Ink"), StrokeThickness = 1, Width = 12, Height = 12 };
        }

        private static Button CaptionButton(string name, string geometry, Action click)
        {
            var button = new Button { Style = (Style)Application.Current.FindResource("Caption"), Content = Glyph(geometry), ToolTip = name };
            AutomationProperties.SetName(button, name);
            button.Click += delegate { click(); };
            return button;
        }

        private static Button ActionButton(string label, bool primary, RoutedEventHandler click)
        {
            var button = new Button {
                Content = label, IsDefault = primary,
                Style = (Style)Application.Current.FindResource(primary ? "Primary" : "Action")
            };
            button.Click += click;
            return button;
        }

        private StackPanel Page(string heading, string description, bool showVersion)
        {
            content.Children.Clear();
            var stack = new StackPanel { Margin = new Thickness(36, 25, 36, 20), MaxWidth = 572 };
            var view = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Content = stack };
            if (layout == Layout.Sidebar && updateMarker == null)
            {
                var shell = new DockPanel();
                var rail = new StackPanel { Margin = new Thickness(20, 28, 18, 24) };
                rail.Children.Add(new Image { Width = 40, Height = 40, Source = logo, HorizontalAlignment = HorizontalAlignment.Left });
                rail.Children.Add(Text("Установка", 14, "Ink", true, new Thickness(0, 18, 0, 0)));
                rail.Children.Add(Text(version, 12, "Muted", false, new Thickness(0, 4, 0, 0)));
                var left = new Border { Width = 150, BorderThickness = new Thickness(0, 0, 1, 0), BorderBrush = Color("Line"), Child = rail };
                DockPanel.SetDock(left, Dock.Left);
                shell.Children.Add(left);
                shell.Children.Add(view);
                content.Children.Add(shell);
            }
            else content.Children.Add(view);

            stack.Children.Add(Text(heading, 27, "Ink", true, new Thickness(0)));
            if (description != null)
                stack.Children.Add(Text(description, 14, "Muted", false, new Thickness(0, 5, 0, 0)));
            if (showVersion)
                stack.Children.Add(Text(version, 12, "Muted", false, new Thickness(0, 8, 0, 0)));
            return stack;
        }

        private void ShowSetup()
        {
            var isStepper = layout == Layout.Steps;
            var page = Page(step == 0 ? "Установка PULL" : "Папка установки",
                step == 0 && isStepper ? "Выберите, для кого установить приложение." : null,
                layout == Layout.Compact);

            if (isStepper)
            {
                var tabs = new DockPanel { LastChildFill = true, Margin = new Thickness(0, 14, 0, 0) };
                var versionLabel = Text(version, 12, "Muted", false, new Thickness(8, 0, 0, 0));
                DockPanel.SetDock(versionLabel, Dock.Right);
                tabs.Children.Add(versionLabel);
                var steps = new StackPanel { Orientation = Orientation.Horizontal };
                steps.Children.Add(StepBadge("Пользователи", step == 0));
                steps.Children.Add(StepBadge("Папка", step == 1));
                tabs.Children.Add(steps);
                page.Children.Add(tabs);
            }

            if (!isStepper || step == 0) BuildScope(page);
            if (!isStepper || step == 1) BuildDirectory(page);

            error = Text("", 13, "Error", false, new Thickness(0, 8, 0, 0));
            error.Visibility = Visibility.Collapsed;
            page.Children.Add(error);
            if (isStepper && step == 0)
                AddActions(page, "Продолжить", delegate {
                    allUsers = machineChoice.IsChecked == true;
                    step = 1;
                    ShowSetup();
                }, "Отмена", delegate { Close(); });
            else
                AddActions(page, "Установить", Install,
                    isStepper ? "Назад" : "Отмена", delegate {
                        if (isStepper)
                        {
                            launchAfter = launch.IsChecked == true;
                            installDirectory = directory.Text;
                            directory = null;
                            step = 0;
                            ShowSetup();
                        }
                        else Close();
                    });
        }

        private static Border StepBadge(string label, bool selected)
        {
            return new Border {
                Child = Text(label, 12, selected ? "Ink" : "Muted", selected, new Thickness(0)),
                Background = Color(selected ? "Soft" : "Background"),
                Padding = new Thickness(11, 6, 11, 6), CornerRadius = new CornerRadius(6)
            };
        }

        private void BuildScope(StackPanel page)
        {
            directory = null;
            TextBlock heading = Text("Доступ", 14, "Ink", true, new Thickness(0, 17, 0, 8));
            page.Children.Add(heading);
            var scopes = new Grid();
            scopes.ColumnDefinitions.Add(new ColumnDefinition());
            scopes.ColumnDefinitions.Add(new ColumnDefinition());
            var current = new RadioButton { GroupName = "scope", Content = "Только для меня", IsChecked = !allUsers, Foreground = Color("Ink"), Padding = new Thickness(3, 0, 0, 0) };
            machineChoice = new RadioButton { GroupName = "scope", Content = "Для всех пользователей", IsChecked = allUsers, Foreground = Color("Ink"), Padding = new Thickness(3, 0, 0, 0) };
            scopes.Children.Add(Option(current, new Thickness(0, 0, 5, 0)));
            var all = Option(machineChoice, new Thickness(5, 0, 0, 0));
            Grid.SetColumn(all, 1);
            scopes.Children.Add(all);
            page.Children.Add(scopes);
            current.Checked += delegate { ChangeScope(false); };
            machineChoice.Checked += delegate { ChangeScope(true); };
        }

        private static Border Option(RadioButton button, Thickness margin)
        {
            return new Border {
                Child = button, Background = Brushes.White, BorderBrush = Color("Line"),
                BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(9),
                Padding = new Thickness(12, 12, 8, 12), Margin = margin
            };
        }

        private void ChangeScope(bool value)
        {
            if (value == allUsers) return;
            allUsers = value;
            installDirectory = DefaultDirectory(allUsers);
            if (directory != null) directory.Text = installDirectory;
        }

        private void BuildDirectory(StackPanel page)
        {
            page.Children.Add(Text("Куда установить PULL", 14, "Ink", true, new Thickness(0, 18, 0, 8)));
            var field = new DockPanel { LastChildFill = true };
            var browse = ActionButton("Обзор", false, delegate {
                using (var dialog = new Forms.FolderBrowserDialog())
                {
                    dialog.Description = "Выберите папку для PULL";
                    if (Directory.Exists(directory.Text)) dialog.SelectedPath = directory.Text;
                    if (dialog.ShowDialog(new FolderOwner(new System.Windows.Interop.WindowInteropHelper(this).Handle)) == Forms.DialogResult.OK)
                        directory.Text = NormalizeDirectory(dialog.SelectedPath);
                }
            });
            browse.Margin = new Thickness(8, 0, 0, 0);
            DockPanel.SetDock(browse, Dock.Right);
            field.Children.Add(browse);
            directory = new TextBox {
                Text = installDirectory, Background = Brushes.White, Foreground = Color("Ink"),
                BorderThickness = new Thickness(0), VerticalContentAlignment = VerticalAlignment.Center, FontSize = 13
            };
            AutomationProperties.SetName(directory, "Папка установки");
            field.Children.Add(new Border {
                Background = Brushes.White, BorderBrush = Color("Line"), BorderThickness = new Thickness(1),
                Child = directory, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(9)
            });
            page.Children.Add(field);
            launch = new CheckBox { Content = "Открыть PULL после установки", IsChecked = launchAfter, Foreground = Color("Ink"), Margin = new Thickness(0, 16, 0, 0) };
            page.Children.Add(launch);
        }

        private static void AddActions(StackPanel page, string primary, RoutedEventHandler action, string secondary, RoutedEventHandler alternate)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 21, 0, 0) };
            if (secondary != null)
            {
                var button = ActionButton(secondary, false, alternate);
                button.Margin = new Thickness(0, 0, 8, 0);
                row.Children.Add(button);
            }
            row.Children.Add(ActionButton(primary, true, action));
            page.Children.Add(row);
        }

        private async void Install(object sender, RoutedEventArgs args)
        {
            if (busy) return;
            try
            {
                installDirectory = NormalizeDirectory(directory.Text);
                SetupPayload.ValidateDirectory(installDirectory, allUsers);
            }
            catch (Exception failure)
            {
                ShowError(failure.Message);
                return;
            }
            launchAfter = launch.IsChecked == true;
            busy = true;
            closeButton.IsEnabled = false;
            ShowProgress(false);
            try
            {
                await Task.Run(delegate { SetupPayload.Install(installDirectory, allUsers, version); });
                var done = Page("PULL установлен", version, false);
                AddActions(done, launchAfter ? "Открыть PULL" : "Готово", delegate {
                    try
                    {
                        if (launchAfter) Process.Start(Path.Combine(installDirectory, "PULL.exe"));
                        Close();
                    }
                    catch (Exception failure) { MessageBox.Show(this, failure.Message, Title); }
                }, launchAfter ? "Закрыть" : null, delegate { Close(); });
            }
            catch (Exception failure)
            {
                ShowSetup();
                ShowError(failure.Message);
            }
            finally
            {
                busy = false;
                closeButton.IsEnabled = true;
            }
        }

        private void ShowError(string message)
        {
            error.Text = message;
            error.Visibility = Visibility.Visible;
        }

        private void ShowProgress(bool updating)
        {
            var page = Page(updating ? "Устанавливаю обновление" : "Устанавливаю PULL",
                updating ? "PULL откроется после перезапуска." : installDirectory, true);
            page.Children.Add(new ProgressBar {
                IsIndeterminate = true, Height = 4, Margin = new Thickness(0, 20, 0, 0),
                Foreground = Color("Ink"), Background = Color("Soft"), BorderThickness = new Thickness(0)
            });
        }

        private void TrackUpdate()
        {
            var elapsed = Stopwatch.StartNew();
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
            timer.Tick += delegate {
                if (elapsed.ElapsedMilliseconds < 650) return;
                if (!File.Exists(updateMarker))
                {
                    timer.Stop();
                    Close();
                }
                else if (elapsed.Elapsed >= TimeSpan.FromMinutes(4))
                {
                    timer.Stop();
                    var page = Page("Обновление ещё не подтверждено", "Если PULL не открылся, попробуйте запустить его через меню «Пуск».", false);
                    AddActions(page, "Закрыть", delegate { Close(); }, null, null);
                }
            };
            Closed += delegate { timer.Stop(); };
            timer.Start();
        }

        private static string DefaultDirectory(bool machine)
        {
            var existing = SetupPayload.ReadInstallValue(machine, "InstallLocation");
            if (!String.IsNullOrWhiteSpace(existing)) return existing;
            var root = Environment.GetFolderPath(machine ? Environment.SpecialFolder.ProgramFiles : Environment.SpecialFolder.LocalApplicationData);
            return machine ? Path.Combine(root, "PULL") : Path.Combine(root, "Programs", "PULL");
        }

        private static string NormalizeDirectory(string value)
        {
            value = (value ?? "").Trim();
            if (value.Length < 3 || value[1] != ':' || (value[2] != '\\' && value[2] != '/') || value.IndexOf('"') >= 0)
                throw new InvalidOperationException("Укажите полный путь к папке на локальном диске.");
            var full = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
            return Path.GetFileName(full).Equals("PULL", StringComparison.OrdinalIgnoreCase) ? full : Path.Combine(full + (full.EndsWith(":") ? "\\" : ""), "PULL");
        }
    }

    internal sealed class FolderOwner : Forms.IWin32Window
    {
        public IntPtr Handle { get; private set; }
        internal FolderOwner(IntPtr handle) { Handle = handle; }
    }

    internal static class SetupPayload
    {
        private const string AppKey = "6ff6da74-ad6a-5cf5-ad0e-1d1daf9d0145";

        internal static string ReadInstallValue(bool machine, string value)
        {
            var hive = machine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser;
            var subkey = value == "InstallLocation" ? @"Software\" + AppKey : @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppKey;
            using (var root = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64))
            using (var key = root.OpenSubKey(subkey))
                return key == null ? null : key.GetValue(value) as string;
        }

        internal static void ValidateDirectory(string folder, bool machine)
        {
            var previous = ReadInstallValue(machine, "InstallLocation");
            if (File.Exists(folder) || (!String.Equals(previous, folder, StringComparison.OrdinalIgnoreCase) &&
                Directory.Exists(folder) && Directory.EnumerateFileSystemEntries(folder).Any()))
                throw new InvalidOperationException("В этой папке уже есть файлы. Выберите пустую папку.");
        }

        internal static void Install(string folder, bool machine, string version)
        {
            ValidateDirectory(folder, machine);
            var temp = Path.Combine(Path.GetTempPath(), "PULL-setup-" + Guid.NewGuid().ToString("N"));
            var file = Path.Combine(temp, "PULL-setup.exe");
            Directory.CreateDirectory(temp);
            try
            {
                using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("Pull.Payload"))
                {
                    if (payload == null) throw new InvalidOperationException("В установщике отсутствует пакет PULL.");
                    using (var output = File.Open(file, FileMode.CreateNew, FileAccess.Write)) payload.CopyTo(output);
                }
                using (var identity = WindowsIdentity.GetCurrent())
                {
                    var elevate = machine && !new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
                    var start = new ProcessStartInfo(file, "/S " + (machine ? "/allusers" : "/currentuser") + " --updated /D=" + folder) {
                        UseShellExecute = elevate, CreateNoWindow = true
                    };
                    if (elevate) start.Verb = "runas";
                    using (var child = Process.Start(start))
                    {
                        child.WaitForExit();
                        if (child.ExitCode != 0) throw new InvalidOperationException("Установка завершилась с кодом " + child.ExitCode + ".");
                    }
                }
                if (ReadInstallValue(machine, "DisplayVersion") != version ||
                    !String.Equals(ReadInstallValue(machine, "InstallLocation"), folder, StringComparison.OrdinalIgnoreCase) ||
                    !File.Exists(Path.Combine(folder, "PULL.exe")))
                    throw new InvalidOperationException("Windows не подтвердила установку PULL.");
            }
            finally
            {
                try { File.Delete(file); Directory.Delete(temp); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }
}
