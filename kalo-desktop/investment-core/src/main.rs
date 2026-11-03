fn main() {
    let root = std::env::args_os().nth(1).map(std::path::PathBuf::from);
    let result = root
        .ok_or("用法：kalo-investment <数据目录>；从标准输入读取 JSON 请求".to_string())
        .and_then(|root| kalo_investment::worker(&root, false));
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
